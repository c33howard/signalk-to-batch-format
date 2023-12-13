/*
 * Copyright 2020 Craig Howard <craig@choward.ca>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require('debug')('signalk-to-batch-format');
const trace = require('debug')('signalk-to-batch-format:trace');

const _ = require('lodash');
const aws = require('aws-sdk');
const crypt = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const s3 = new aws.S3();

const batcher = require('signalk-batcher').to_batch;

module.exports = function(app) {
    let _batcher = batcher(app);
    let _sweeper_interval;

    let _ensure_directory_exists = function(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    };

    let _format_value = function(value) {
        // escape " as ""
        if (typeof(value) === 'string') {
            value = value.replace(/"/g, '""');
            value = `"${value}"`;
        }

        return value;
    };

    let _write_file = function(options, batch_of_points) {
        const filename = `${batch_of_points.timestamp}.json`;

        // start with the file as a tmp file, then rename when done
        const path = `${options.directory}/${filename}.gz`;
        const tmp_path = `${path}~`;

        // write to this file
        const file_stream = fs.createWriteStream(tmp_path);
        // but gzip, so connect the streams
        const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
        gzip.pipe(file_stream);

        // use "os" (for output stream) as the write end of the stream
        const os = gzip;

        // write file
        os.write(JSON.stringify(batch_of_points));
        os.write('\n');

        // after we're done writing, atomically rename into place and maybe upload
        os.on('finish', function() {
            fs.rename(tmp_path, path, function(err) {
                if (err) {
                    debug(`could not rename ${tmp_path} to ${path}`);
                }

                if (options.s3_bucket) {
                    _upload(options, filename);
                }
            });
        });

        // close the file
        os.end();
    };

    let _publish_batch = function(options) {
        _ensure_directory_exists(options.directory);

        return function(batch_of_points) {
            trace(`_publish_batch`);

            try {
                _write_file(options, batch_of_points);
            } catch (e) {
                // TODO: how to handle error?
                debug(e);
            }
        };
    };

    let _upload = function(options, filename) {
        const path = `${options.directory}/${filename}.gz`;

        let _get_md5 = function(file) {
            var hash = crypt.createHash('md5')
                .update(file)
                .digest('base64');
            return hash;
        }

        fs.readFile(path, function(err, data) {
            if (err) {
                debug(err);
                return;
            }

            const md5 = _get_md5(data);
            const buffer = Buffer.from(data);

            const params = {
                Body: buffer,
                Bucket: options.s3_bucket,
                Key: `${options.s3_key_prefix}${filename}.gz`,
                ContentMD5: md5,
                ContentEncoding: 'gzip',
                ContentType: 'application/json'
            };

            if (options.s3_tags) {
                params.Tagging = options.s3_tags;
            }

            trace(`starting upload of ${path} to ${params.Bucket}/${params.Key}`);

            s3.putObject(params, function(err, data) {
                if (err) {
                    debug(err);
                } else {
                    trace(`upload of ${path} done`);

                    // we've uploaded to s3, so we can delete locally
                    fs.unlink(path, function() {});
                }
            });
        });
    };

    let _sweeper = function(options) {
        trace('running _sweeper');
        fs.readdir(options.directory, function(err, files) {
            if (err) {
                debug(`_sweeper error ${err}`);
                return;
            }

            const should_upload_file = function() {
                const now = Date.now();
                // only consider the file eligible for the sweeper when it's
                // been sitting around for 10x the publish_interval (which is in
                // s, so we need to convert to ms)
                const min_elapsed_ms = options.publish_interval * 1000 * 10;

                return function(filename) {
                    // check to ensure the file is old, to avoid races with a
                    // regular upload

                    // filenames are "${timestamp}.json.gz" (see _write_file())
                    // and we want to extract the timestamp.  The calling code
                    // has already stripped ".gz", but we need to strip ".json"
                    // in order to do date math.
                    const timestamp_from_filename = filename.substr(0, filename.length - 5);
                    const elapsed_ms = now - new Date(timestamp_from_filename);
                    return elapsed_ms >= min_elapsed_ms;
                };
            }();

            // we're only interested in gzipped files
            files = files.filter(f => f.endsWith('.gz'));
            // remove the gzip extension (as _upload puts it back, and we need
            // to remote it to calculate the elapsed time)
            files = files.map(f => f.substr(0, f.length - 3));
            // find the files whose time has elapsed
            files = files.filter(should_upload_file);

            trace(`_sweeper uploading files: ${files}`);

            // TODO: we'll continue trying to upload a file forever, perhaps I
            // need a dead-letter queue of some sort?
            // upload those files
            files.map(function(f) { _upload(options, f); });
        });
    };

    let _start = function(options) {
        debug('starting');
        _directory = options.directory;

        // start the work
        _batcher.start(options, _publish_batch(options));

        // start the sweeper to catch files we missed uploading to S3 during
        // connectivity hiccups
        if (options.s3_bucket) {
            const ten_minutes_in_ms = 10 * 60 * 1000;
            _sweeper_interval = setInterval(function() {
                _sweeper(options);
            }, ten_minutes_in_ms);
        }
    };

    let _stop = function(options) {
        debug('stopping');

        // stop the work
        _batcher.stop(options);

        // stop the sweeper
        if (_sweeper_interval) {
            clearInterval(_sweeper_interval);
        }

        // clean up the state
        _sweeper_interval = undefined;
    };

    const _plugin = {
        id: 'signalk-to-batch-format',
        name: 'Batch format writer',
        description: 'SignalK server plugin that writes batched compressed json files to disk',

        schema: {
            type: 'object',
            required: ['directory'],
            properties: {
                directory: {
                    type: 'string',
                    title: 'Directory to write files to',
                },
                get_interval: {
                    type: 'number',
                    title: 'Update Interval',
                    description: 'Frequency to list signalk state (in seconds)',
                    default: 1
                },
                publish_interval: {
                    type: 'number',
                    title: 'Publish Interval',
                    description: 'Frequency to publish/write files (in seconds)',
                    default: 60
                },
                filter_list_type: {
                    type: 'string',
                    title: 'Type of List',
                    description: 'Either include or exclude the paths when publishing to Timestream',
                    default: 'exclude',
                    enum: ['include', 'exclude']
                },
                filter_list: {
                    title: 'SignalK Paths',
                    description: 'A list of paths to be excluded or included',
                    type: 'array',
                    default: [],
                    items: {
                        type: 'string',
                        title: 'Path'
                    }
                },
                s3_bucket: {
                    type: 'string',
                    title: 'S3 bucket to upload completed json'
                },
                s3_key_prefix: {
                    type: 'string',
                    title: 'Optional prefix for all S3 keys',
                    description: 'ex: signalk-timeseries/'
                },
                s3_tags: {
                    type: 'string',
                    title: 'S3 tags for uploaded objects',
                    description: 'tag1=value1&tag2=value2'
                }
            }
        },

        start: _start,
        stop: _stop
    };

    return _plugin;
};
