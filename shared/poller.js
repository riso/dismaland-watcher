"use strict";

var _ = require("lodash");
var superagent = require("superagent");
var async = require("async");
var logging = require("./logging");
var cheerio = require("cheerio");

/**
 * Create a new instance of Poller.
 * @constructor
 */
function Poller() {
  this.logger = logging.logger;
};

/**
 * Starts the poller, setting the timer specified in
 * `POLLING_INTERVAL` environment variable.
 * @param {Function} callback(error, results) function that will be called when
 * processing is completed or any error is raised. Parameters:
 * - `error` any error, if present
 * - `result` an object with the following fields:
 *      - `status` "available" if there is at least a time slot available,
 *        "unavailable" otherwise
 *      - `details` an array of objects with the following fields:
 *        - `slot` the available time slot
 *        - `price` cost of the slot
 */
Poller.prototype.startPolling = function startPolling(callback) {
  var self = this;
  // Start polling
  setInterval(function() {
    self.poll(callback);
  }, process.env["POLLING_INTERVAL"]);
  this.logger.info("Polling started");
};

/**
 * Perform a polling cycle. Retrieves the calendar page and search for available
 * dates.
 *
 * Any error on a date will immediately stop the processing of that listing
 * but will not block the entire polling cycle.
 * It will instead populate the `results[].error` of the callback with the
 * generated error.
 *
 * @param {Function} callback(error, results) function that will be called when
 * processing is completed or any error is raised. Parameters:
 * - `error` any error, if present
 * - `result` an object with the following fields:
 *      - `status` "available" if there is at least a time slot available,
 *        "unavailable" otherwise
 *      - `details` an array of objects with the following fields:
 *        - `slot` the available time slot
 *        - `price` cost of the slot
 */
Poller.prototype.poll = function poll(callback) {
  var self = this;

  var pages = [
    "http://www.seetickets.com/tour/dismaland/calendar/1",
    "http://www.seetickets.com/tour/dismaland/calendar/2"
  ];
  async.map(pages, function(page, cb) {
    async.waterfall([
      function getPage(cb) {
        superagent.get("http://www.seetickets.com/tour/dismaland/calendar").
        end(function(err, res) {
          self.logger.debug("Called calendar page %s", page, {});
          cb(null, err, res);
        });
      },
      function processPage(err, res, cb) {
        if (err) {
          self.logger.error(err);
          return cb(err);
        }

        var $ = cheerio.load(res.text);

        var shows = $(".day-has-shows .times .show-lowest-price");
        if (shows.length == 0) return cb(null, false);

        // there was some show, return true
        cb(null, true);

      }
    ], cb);
  }, function(err, results) {
    // results is an array of boolean
    self.logger.debug("Done processing pages: %j", results, {});

    var result = {};
    result.status = (_.reduce(results, function(acc, result) {
      return acc || result;
    }, false) ? "available" : "unavailable");

    callback(err, result);
  });
};

/**
 * Process a single listing, by updating its payload if required, eventually
 * creating the cards on ECPFeeder and on the Redis queue.
 *
 * Any error on a card will immediately stop the
 * processing of that card but will not block the entire polling cycle.
 * It will instead populate the `result.cards[].error` of the callback with the
 * generated error.
 *
 * @param {Object} listing the listing that is being processed, at least
 * `listingId` must be populated
 * @param {Function} callback(error, result) function that will be called when
 * processing is completed or any error is raised. Parameters:
 * - `error` any error, if present
 * - `result` an object with the following fields:
 *      - `listing` the updated listing
 *      - `cards` array of processed cards. (`cards[].card` will
 *        hold the card and `cards[].job` will hold the redis job)
 */
Poller.prototype.processListing = function processListing(listing, callback) {
  var self = this;
  var listingId = listing.listingId;
  var deviceId = this.config.getString("DEVICE_ID");

  this.logger.debug("Processing listing %j", listing, {});

  async.waterfall([
    function getHightlights(cb) {
      self.logger.debug("Retrieving highlights for %j",
        {"listingId": listingId, "deviceId": deviceId}, {});
      self.HighlightsService.getHightlights(listingId, deviceId, cb);
    },
    function savePayload(res, cb) {
      self.logger.debug("Got payload %j for listing %d", res, listingId, {});
      if (_.isEqual(listing.payload, res)) {
        self.logger.debug("Payload unchanged for listing %d", listingId);
        return cb("Payload unchanged", {listing: listing});
      }

      listing.payload = res;
      // Store payload on listing
      listing.save(function(err, listing) {cb(null, err, listing);});
    },
    function convertPayload(err, listing, cb) {
      if (err) {
        self.logger.error(err);
        return cb(err, {listing: listing});
      }

      // Transform returned payload into what ECPFeeder expects
      var cards = self.listingToCards(listing);

      // Store all the video cards on feed and queue them on Redis, in parallel,
      // then return to the callback the array of results or any error.
      // As with listing, we can't feed the processCard to async.map directly
      // or, in case of error on a card, the entire process would block.
      // We insead use a different callback that 'materializes' the error
      // without throwing it.
      async.map(cards, function(card, cb) {
        self.processCard(card, function(err, res) {
          self.logger.debug("Processed card %j", res, {});
          if (err) res.error = err;
          cb(null, res);
        });
      }, function(err, results) {
        self.logger.debug("Done processing cards for listing %d: %j",
          listingId, results, {});
        if (err) {
          self.logger.error(err);
          return cb(err, {listing: listing, cards: results});
        }
        cb(null, {listing: listing, cards: results});
      });
    }
  ], callback);
};

/**
 * Transform a listings' payload into an array of cards.
 * @param {Object} listing the listing that is being processed
 * @return {Array} an array of cards that can be fed to ECPFeeder
 */
Poller.prototype.listingToCards = function listingToCards(listing) {
  return _.map(listing.payload.annotations, function(annotation) {
    return this.annotationToCard(listing, annotation);
  }, this);
};

/**
 * Transform a listings payload's annotation into a card.
 * @param {Object} listing the listing that is being processed
 * @param {Object} annotation the annotation that is being processed
 * @return {Object} a card that can be fed to ECPFeeder
 */
Poller.prototype.annotationToCard = function annotationToCard(listing, annotation) {
  var card = {};
  card.mimeType = "application/x­mpegURL";
  card.duration = 180;
  card.pubDate = listing.pubDate;
  card.feedId = listing.listingId;
  card.cDVRURL = listing.cDVRURL;
  card.title = annotation.annotation.title;
  card.offset = annotation.offset;

  return card;
};

/**
 * Process a single card, storing in on ECPFeeder and on the Redis queue.
 * @param {Object} card the card that is being processed, at least
 * `feedId` must be populated. Card must also adhere to
 * ECPFeeder VideoCard schema
 * @param {Function} callback(error, result) function that will be called when
 * processing is completed or any error is raised. Parameters:
 * - `error` any error, if present
 * - `result` an object composing the result. (`result.card` will hold the card
 *    and `result.job` will hold the redis job)
 */
Poller.prototype.processCard = function processCard(card, callback) {
  var self = this;
  this.logger.debug("Procesing card %j", card, {});
  async.waterfall([
    function saveCard(cb) {
      superagent.post(self.config.getString("ECPFEEDER_ENDPOINT") + card.feedId).
      send(card).end(function (err, res) {
        self.logger.debug("Saved card %j on ECPFeeder", card, {});
        cb(null, err, res, card);
      });
    },
    function enqueueCard(err, res, card, cb) {
      if (err) {
        self.logger.error(err);
        return cb(err);
      }
      var job = self.queue.create("card", card).save(function(err) {
        // If we have any error, return to the callback keeping track
        // of the object
        if (err) {
          self.logger.error(err);
          return cb(err, {card: card});
        }
        self.logger.debug("Queued card %j on Redis", card, {});
      });
      // return the processed card to the callback
      cb(null, {card: card, job: job});
    }
  ], callback);
};

module.exports = Poller;
