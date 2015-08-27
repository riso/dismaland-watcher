"use strict";

var sendmail = require('sendmail')();
var logging = require("./shared/logging");
var logger = logging.logger;
var _ = require("lodash");
var Poller = require("./shared/poller");
var PushBullet = require('pushbullet');
var pusher = new PushBullet(process.env["PUSHBULLET_KEY"]);

var poller = new Poller();
var currentResult = {};
poller.startPolling(function(err, result) {
  if (err) logger.error("Polling error %j", err, {});
  logger.verbose("Polling result %j", result, {});

  if (!_.eq(currentResult,result)) {
    currentResult = result;
    logger.info("Polling result changed to %j", result, {});

    sendmail({
      from: "dimwatch@slytherin-basement.com",
      to: process.env["MAIL_RECIPIENT"],
      subject: "Dismaland availability changed!",
      content: 'Dismaland is now ' + result.status,
    }, function(err, reply) {
      if (err) logger.error("Error sending email %j", err, {});
    });

    pusher.devices(function(error, response) {
      // response is the JSON response from the API
    });
    pusher.note(null,
      "Dismaland availability changed!",
      "Dismaland is now " + result.status,
      function(err, response) {
        // response is the JSON response from the API
        if (err) logger.error("Error sending pushbullet %j", err, {});
      }
    );
  }
});
