"use strict";

var winston = require("winston");

var winstonTransports = [];
if (process.env["CONSOLE_LOG_ENABLED"] === "true") {
  var level = process.env["CONSOLE_LOG_LEVEL_APP"] || process.env["CONSOLE_LOG_LEVEL"] || "debug";
  winstonTransports.push(new (winston.transports.Console)({
      timestamp: true,
      prettyPrint: true,
      level: level
  }));
}

var logger = new (winston.Logger)({transports: winstonTransports});

module.exports = {
  logger: logger
}
