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

        var shows = $(".day-has-shows .times a");
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

module.exports = Poller;
