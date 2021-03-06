'use strict';

const stream = require('stream');
const util = require('util');
const asyncForEach = require('async/forEach');
const { LEVEL } = require('triple-beam');
const isStream = require('is-stream');
const ExceptionHandler = require('./exception-handler');
const LegacyTransportStream = require('winston-transport/legacy');
const Profiler = require('./profiler');
const common = require('./common');
const config = require('./config');

const formatRegExp = common.formatRegExp;

/*
 * Constructor function for the Logger object responsible
 * for persisting log messages and metadata to one or more transports.
 */
var Logger = module.exports = function Logger(options) {
  stream.Transform.call(this, { objectMode: true });
  this.configure(options);
};

//
// Inherit from `stream.Transform`.
//
util.inherits(Logger, stream.Transform);

/*
 * ### function configure (options)
 * This will wholesale reconfigure this instance by:
 * 1. Resetting all transports. Older transports will be removed implicitly.
 * 2. Set all other options including levels, colors, rewriters, filters,
 *    exceptionHandlers, etc.
 */
Logger.prototype.configure = function (options) {
  //
  // Reset transports if we already have them
  //
  if (this.transports.length) {
    this.clear();
  }

  options = options || {};
  this.format = options.format || this.format || require('logform/json')();

  var levels = options.levels || this.levels || config.npm.levels;
  var maxLength = Math.max.apply(null, Object.keys(levels)
    .map(function (lev) { return lev.length; }));

  this.paddings = Object.keys(levels).reduce(function (acc, lev) {
    var pad = lev.length !== maxLength
      ? new Array(maxLength - lev.length + 1).join(' ')
      : '';

    acc[lev] = pad;
    return acc;
  }, {});

  //
  // Hoist other options onto this instance.
  //
  this.levels = levels;
  this.level = options.level || 'info';
  this.exceptions = new ExceptionHandler(this);
  this.profilers = {};
  this.exitOnError = typeof options.exitOnError !== 'undefined'
    ? options.exitOnError
    : true;

  //
  // Add all transports we have been provided.
  //
  if (options.transports) {
    options.transports = Array.isArray(options.transports)
      ? options.transports
      : [options.transports];

    options.transports.forEach(function (transport) {
      this.add(transport);
    }, this);
  }

  if (options.colors || options.emitErrs || options.formatters
    || options.padLevels || options.rewriters || options.stripColors) {
    throw new Error([
      '{ colors, emitErrs, formatters, padLevels, rewriters, stripColors } were removed in winston@3.0.0.',
      'Use a custom winston.format(function) instead.',
      'See: https://github.com/winstonjs/winston/tree/master/UPGRADING.md'
    ].join('\n'));
  }

  if (options.exceptionHandlers) {
    this.exceptions.handle(options.exceptionHandlers);
  }
};

/*
 * @property {Array} Represents the current readableState
 * pipe targets for this Logger instance.
 */
Object.defineProperty(Logger.prototype, 'transports', {
  configurable: false,
  enumerable: true,
  get: function () {
    var pipes = this._readableState.pipes;
    return !Array.isArray(pipes)
      ? [pipes].filter(Boolean)
      : pipes;
  }
});

/*
 * function log (level, msg, meta)
 * function log (info)
 * Ensure backwards compatibility with a `log` method
 *
 * Supports the existing API, which is now DEPRECATED:
 *
 *    logger.log('info', 'Hello world', { custom: true });
 *    logger.log('info', new Error('Yo, it's on fire'));
 *    logger.log('info', '%s %d%%', 'A string', 50, { thisIsMeta: true });
 *
 * And the new API with a single JSON literal:
 *
 *    logger.log({ level: 'info', message: 'Hello world', custom: true });
 *    logger.log({ level: 'info', message: new Error('Yo, it's on fire') });
 *    logger.log({
 *      level: 'info',
 *      message: '%s %d%%',
 *      splat: ['A string', 50],
 *      meta: { thisIsMeta: true }
 *    });
 *
 * @api public
 */
Logger.prototype.log = function log(level, msg, meta) {
  //
  // Optimize for the hotpath of logging JSON literals
  //
  if (arguments.length === 1) {
    //
    // Yo dawg, I heard you like levels ... seriously ...
    // In this context the LHS `level` here is actually
    // the `info` so read this as:
    // info[LEVEL] = info.level;
    //
    level[LEVEL] = level.level;
    this.write(level);
    return this;
  }

  //
  // Slightly less hotpath, but worth optimizing for.
  //
  if (arguments.length === 2) {
    if (msg && typeof msg === 'object') {
      msg[LEVEL] = msg.level = level;
      this.write(msg);
      return this;
    }

    this.write({ [LEVEL]: level, level, message: msg });
    return this;
  }

  //
  // Separation of the splat from { level, message, meta } must be done
  // at this point in the objectMode stream since we only ever write
  // a single object.
  //
  const tokens = msg && msg.match && msg.match(formatRegExp);
  if (tokens) {
    this._splat({ [LEVEL]: level, level, message: msg }, tokens, Array.prototype.slice.call(arguments, 2));
    return this;
  }

  const metaObj = meta instanceof Error ? { err: meta.stack } : { meta };
  const info = Object.assign({}, metaObj, { [LEVEL]: level, level, message: msg });
  this.write(info);
  return this;
};

/*
 * @private function _transform (obj)
 * Pushes data so that it can be picked up by all of
 * our pipe targets.
 */
Logger.prototype._transform = function _transform(info, enc, callback) {
  //
  // [LEVEL] is only soft guaranteed to be set here since we are a proper
  // stream. It is likely that `info` came in through `.log(info)` or
  // `.info(info)`. If it is not defined, however, define it.
  // This LEVEL symbol is provided by `triple-beam` and also used in:
  // - logform
  // - winston-transport
  // - abstract-winston-transport
  //
  if (!info[LEVEL]) {
    info[LEVEL] = info.level;
  }

  //
  // Remark: really not sure what to do here, but this has been
  // reported as very confusing by pre winston@2.0.0 users as
  // quite confusing when using custom levels.
  //
  if (!this.levels[info[LEVEL]] && this.levels[info[LEVEL]] !== 0) {
    console.error('[winston] Unknown logger level: %s', info[LEVEL]);
  }

  //
  // Remark: not sure if we should simply error here.
  //
  if (!this._readableState.pipes) {
    console.error('[winston] Attempt to write logs with no transports %j', info);
  }

  //
  // Here we write to the `format` pipe-chain, which
  // on `readable` above will push the formatted `info`
  // Object onto the buffer for this instance.
  //
  this.push(this.format.transform(info, this.format.options));
  callback();
};

/*
 * @private function _splat (info, tokens, splat)
 * Check to see if tokens <= splat.length, assign { splat, meta } into the `info`
 * accordingly, and write to this instance.
 */
Logger.prototype._splat = function _splat(info, tokens, splat) {
  const percents = info.message.match(common.escapedPercent);
  const escapes = percents && percents.length || 0;

  //
  // The expected splat is the number of tokens minus the number of escapes. e.g.
  //
  // - { expectedSplat: 3 } '%d %s %j'
  // - { expectedSplat: 5 } '[%s] %d%% %d%% %s %j'
  //
  // Any "meta" will be arugments in addition to the expected splat size
  // regardless of type. e.g.
  //
  // logger.log('info', '%d%% %s %j', 100, 'wow', { such: 'js' }, { thisIsMeta: true });
  // would result in splat of four (4), but only three (3) are expected. Therefore:
  //
  // extraSplat = 3 - 4 = -1
  // metas = [100, 'wow', { such: 'js' }, { thisIsMeta: true }].splice(-1, -1 * -1);
  // splat = [100, 'wow', { such: 'js' }]
  //
  const expectedSplat = tokens.length - escapes;
  const extraSplat = expectedSplat - splat.length;
  const metas = extraSplat < 0
    ? splat.splice(extraSplat, -1 * extraSplat)
    : [];

  //
  // Now that { splat } has been separated from any potential { meta }
  // we can assign this to the `info` object and write it to our format stream.
  //
  info.splat = splat;
  if (metas.length) {
    info.meta = metas[0];
  }

  this.write(info);
};

/*
 * function add (transport)
 * Adds the transport to this logger instance by
 * piping to it.
 */
Logger.prototype.add = function add(transport) {
  //
  // Support backwards compatibility with all existing
  // `winston@1.x.x` transport. All NEW transports should
  // inherit from `winston.TransportStream`.
  //
  var target = !isStream(transport)
    ? new LegacyTransportStream({ transport: transport })
    : transport;

  if (!target._writableState || !target._writableState.objectMode) {
    throw new Error('Transports must WritableStreams in objectMode. Set { objectMode: true }.');
  }

  //
  // Listen for the `error` event on the new Transport
  //
  this._onError(target);
  this.pipe(target);

  if (transport.handleExceptions) {
    this.exceptions.handle();
  }

  return this;
};

/*
 * function remove (transport)
 * Removes the transport from this logger instance by
 * unpiping from it.
 */
Logger.prototype.remove = function remove(transport) {
  var target = transport;
  if (!isStream(transport)) {
    target = this.transports.filter(function (match) {
      return match.transport === transport;
    })[0];
  }

  if (target) { this.unpipe(target); }
  return this;
};

/*
 * function clear (transport)
 * Removes all transports from this logger instance.
 */
Logger.prototype.clear = function clear() {
  this.unpipe();
  return this;
};

/*
 * ### function close ()
 * Cleans up resources (streams, event listeners) for all
 * transports associated with this instance (if necessary).
 */
Logger.prototype.close = function close() {
  this.clear();
  this.emit('close');
  return this;
};

/*
 * Sets the `target` levels specified on this instance.
 * @param {Object} Target levels to use on this instance.
 */
Logger.prototype.setLevels = common.warn.deprecated('setLevels');

//
// ### function query (options, callback)
// #### @options {Object} Query options for this instance.
// #### @callback {function} Continuation to respond to when complete.
// Queries the all transports for this instance with the specified `options`.
// This will aggregate each transport's results into one object containing
// a property per transport.
//
Logger.prototype.query = function query(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  options = options || {};
  const results = {};
  const queryObject = common.clone(options.query) || {};

  //
  // Helper function to query a single transport
  //
  function queryTransport(transport, next) {
    if (options.query) {
      options.query = transport.formatQuery(queryObject);
    }

    transport.query(options, function (err, results) {
      if (err) {
        return next(err);
      }

      next(null, transport.formatResults(results, options.format));
    });
  }

  //
  // Helper function to accumulate the results from
  // `queryTransport` into the `results`.
  //
  function addResults(transport, next) {
    queryTransport(transport, function (err, result) {
      //
      // queryTransport could potentially invoke the callback
      // multiple times since Transport code can be unpredictable.
      //
      if (next) {
        result = err || result;
        if (result) {
          results[transport.name] = result;
        }

        // eslint-disable-next-line callback-return
        next();
      }

      next = null;
    });
  }

  //
  // Iterate over the transports in parallel setting the
  // appropriate key in the `results`
  //
  asyncForEach(this.transports.filter(function (transport) {
    return !!transport.query;
  }), addResults, function () {
    callback(null, results);
  });
};

//
// ### function stream (options)
// #### @options {Object} Stream options for this instance.
// Returns a log stream for all transports. Options object is optional.
//
Logger.prototype.stream = function _stream(options) {
  options = options || {};

  const out = new stream.Stream();
  const streams = [];

  out._streams = streams;
  out.destroy = function () {
    var i = streams.length;
    while (i--) streams[i].destroy();
  };

  //
  // Create a list of all transports for this instance.
  //
  this.transports.filter(function (transport) {
    return !!transport.stream;
  }).forEach(function (transport) {
    var stream = transport.stream(options);
    if (!stream) return;

    streams.push(stream);

    stream.on('log', function (log) {
      log.transport = log.transport || [];
      log.transport.push(transport.name);
      out.emit('log', log);
    });

    stream.on('error', function (err) {
      err.transport = err.transport || [];
      err.transport.push(transport.name);
      out.emit('error', err);
    });
  });

  return out;
};

//
// ### function startTimer ()
// Returns an object corresponding to a specific timing. When done
// is called the timer will finish and log the duration. e.g.:
//
//    timer = winston.startTimer()
//    setTimeout(function(){
//      timer.done({ message: 'Logging message' });
//    }, 1000);
//
Logger.prototype.startTimer = function startTimer() {
  return new Profiler(this);
};

//
// ### function profile (id, [info])
// @param {string} id Unique id of the profiler
// Tracks the time inbetween subsequent calls to this method
// with the same `id` parameter. The second call to this method
// will log the difference in milliseconds along with the message.
//
Logger.prototype.profile = function profile(id) {
  const time = Date.now();
  let timeEnd;
  let info;
  let args;

  if (this.profilers[id]) {
    timeEnd = this.profilers[id];
    delete this.profilers[id];

    //
    // Attempt to be kind to users if they are still
    // using older APIs.
    //
    args = Array.prototype.slice.call(arguments, 1);
    if (typeof args[args.length - 1] === 'function') {
      console.warn('Callback function no longer supported as of winston@3.0.0');
      args.pop();
    }

    //
    // Set the duration property of the metadata
    //
    info = typeof args[args.length - 1] === 'object' ? args.pop() : {};
    info.level = info.level || 'info';
    info.durationMs = time - timeEnd;
    info.message = info.message || id;
    return this.write(info);
  }

  this.profilers[id] = time;
  return this;
};

/*
 * Backwards compatibility to `exceptions.handle`
 * in winston < 3.0.0.
 *
 * @api deprecated
 */
Logger.prototype.handleExceptions = function handleExceptions() {
  console.warn('Deprecated: .handleExceptions() will be removed in winston@4. Use .exceptions.handle()');
  var args = Array.prototype.slice.call(arguments);
  this.exceptions.handle.apply(this.exceptions, args);
};

/*
 * Backwards compatibility to `exceptions.handle`
 * in winston < 3.0.0.
 *
 * @api deprecated
 */
Logger.prototype.unhandleExceptions = function unhandleExceptions() {
  console.warn('Deprecated: .unhandleExceptions() will be removed in winston@4. Use .unexceptions.handle()');
  var args = Array.prototype.slice.call(arguments);
  this.exceptions.unhandle.apply(this.exceptions, args);
};

/*
 * Throw a more meaningful deprecation notice
 */
Logger.prototype.cli = function cli() {
  throw new Error([
    'Logger.cli() was removed in winston@3.0.0',
    'Use a custom winston.formats.cli() instead.',
    'See: https://github.com/winstonjs/winston/tree/master/UPGRADING.md'
  ].join('\n'));
};

//
// ### @private function _onError (transport)
// #### @transport {Object} Transport on which the error occured
// #### @err {Error} Error that occurred on the transport
// Bubbles the error, `err`, that occured on the specified `transport`
// up from this instance if `emitErrs` has been set.
//
Logger.prototype._onError = function _onError(transport) {
  var self = this;

  function transportError(err) {
    self.emit('error', err, transport);
  }

  if (!transport.__winstonError) {
    transport.__winstonError = transportError;
    transport.on('error', transport.__winstonError);
  }
};
