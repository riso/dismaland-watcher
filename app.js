"use strict";

var logging = require("./shared/logging");
var logger = logging.logger;

var Poller = require("./shared/poller");

var poller = new Poller();
poller.startPolling(function(err, results) {
  if (err) logger.error("Polling error %j", err, {});
  logger.verbose("Polling result %j", results, {});
});
