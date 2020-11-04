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

const debug = require('debug')('signalk-to-csv');
const trace = require('debug')('signalk-to-csv:trace');

const _ = require('lodash');
const aws = require('aws-sdk');
const crypt = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const s3 = new aws.S3();

const batcher = require('signalk-to-batch-points');

module.exports = function(app) {
    let _batcher = batcher(app);

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

    let _write_csv = function(options, batch_of_points) {
        if (!batch_of_points.header) {
            trace(`nothing to write`);
            return;
        }

        const filename = new Date(batch_of_points.header[0]).toISOString();

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

        // write header
        const header = batch_of_points.header.reduce(function(acc, v) {
            return `${acc},${v}`;
        });
        os.write(`path,${header}\n`);

        // write columns
        for (const [name, points] of Object.entries(batch_of_points.data)) {
            // row header
            os.write(`"${name}"`);

            // points, with each one representing one interval
            points.forEach(value => {
                // format value for serialization
                value = _format_value(value);

                // now write to file
                os.write(`,${value}`);
            });

            // finish the row
            os.write('\n');
        }

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
                _write_csv(options, batch_of_points);
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
                ContentType: 'text/csv'
            };

            if (options.s3_tags) {
                params.Tagging = options.s3_tags;
            }

            s3.putObject(params, function(err, data) {
                if (err) {
                    debug(err);
                } else if (options.rm_after_upload) {
                    fs.unlink(path, function() {});
                }

                trace(`upload of ${path} done`);
            });
        });
    };

    let _start = function(options) {
        debug('starting');
        _directory = options.directory;

        // start the work
        _batcher.start(options, _publish_batch(options));
    };

    let _stop = function(options) {
        debug('stopping');

        // stop the work
        _batcher.stop(options);

        // clean up the state
        _database_name = undefined;
        _table_name = undefined;
    };

    const _plugin = {
        id: 'signalk-to-csv',
        name: 'CSV logger',
        description: 'SignalK server plugin that writes compressed csv files to disk',

        schema: {
            type: 'object',
            required: ['directory'],
            properties: {
                directory: {
                    type: 'string',
                    title: 'Directory to write files to',
                },
                update_interval: {
                    type: 'number',
                    title: 'Frequency to list signalk state (in seconds)',
                    description: 'Each column in the csv represents how many seconds',
                    default: 1
                },
                write_interval: {
                    type: 'number',
                    title: 'Frequency to write files (in seconds)',
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
                    title: 'S3 bucket to upload completed csv to'
                },
                s3_key_prefix: {
                    type: 'string',
                    title: 'Optional prefix for all S3 keys',
                    description: 'signalk-timestream/'
                },
                s3_tags: {
                    type: 'string',
                    title: 'S3 tags for uploaded objects',
                    description: 'tag1=value1&tag2=value2'
                },
                rm_after_upload: {
                    type: 'boolean',
                    title: 'Remove local file after upload to S3',
                    default: false
                }
            }
        },

        start: _start,
        stop: _stop
    };

    return _plugin;
};
