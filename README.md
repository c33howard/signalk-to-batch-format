# SignalK to CSV

SignalK plugin to produce periodic (compressed) CSVs.

# Why CSV?

I want all my data in Amazon Timestream (ie in the cloud) for dashboarding and
later playback.  My boat's connectivity to the cloud comes from an LTE modem
with a data plan.  The LTE modem appears to be 95-99% available and I have fixed
bandwidth per month.  Therefore, I want something that compresses really well,
and can deal with intermittent connectivity issues.

CSVs aren't perfect as far as data compression goes, but they're really good.
I've made each row a signalk path and each column a timestamp, so there's high
degree of repetition.  I'm emitting a data point every second for 63 metrics,
and producing a CSV every 60s.  This CSV is around 3.2KB compressed, which
works out to around 140MB per month of data transfer (plus HTTP headers).

Having flat files on disk is extremely highly available.  Any connectivity
issues cause the file to stay put, and a sweeper can retry later on.  It
current does a scan every 10 minutes and re-uploads everything that's been
sitting on disk for 10x the upload interval.

Finally, CSV is easy to debug.  I could probably do better on compression with
a binary format, but this compresses so well, it's not worth the complexity.

# Why Not...

Direct write to Timestream, because there isn't a good way to get the latest
data most of the time, but get backfills after lost connectivity.  Data
compression was also an issue.

Signalk to signalk.  I tried a signalk on the boat and a signalk in the cloud,
but I ruled that out, because connectivity gaps meant that I missed data.

AWS IOT or MQTT.  I ruled that out, because of how the data was transformed to
MQTT and sent immediately, which led to *much* higher data transfer.  This can
deal with connectivity gaps with a local buffer on the boat.

# Bigger Picture

My setup is my local signalk runs and procduces CSVs.  These are uploaded to
S3.  I've setup a notification running in Lambda that sees new files being
written to S3, the lambda script downloads the file from S3, parses it, writes
to Timestream, then deletes from S3.

An HTTP PUT of the CSVs to a web server that does the write to Timestream would
also work, but S3 is more highly available, and one file per-minute fits
comfortably within the Lambda free-tier, so S3 ends up being both more
available and cheaper.

# Setup

If you're uploading to S3, then Signalk needs permissions to put objects in S3.
Configure this how you normally configure AWS.  The only permission required
should be S3:PutObject.

I created a .aws/credentials file in my home directory like so:

```
node@pi1:/code/signalk-server$ cat ~/.aws/credentials
[signalk-boat]
aws_access_key_id = <redacted>
aws_secret_access_key = <redacted>
region = <redacted>
```

I have an empty file in ~/.aws/config.  I then set the environment variable
`AWS_PROFILE=signalk-boat` before running signalk.  Since this runs in node.js,
you'll also need to set the environment variable `AWS_SDK_CONFIG_FILE=1`.

To avoid unbounded storage growth on S3, you probably want to setup a lifecycle
policy for the CSVs uploaded, or have the Lambda delete the file upon
completion.

# Configuration

At the moment the plugin is hardcoded to only write `self`.  (That means no AIS
contacts will be persisted.  AIS contacts add a *lot* more data to store and
transfer.)

The configuration consists of the following parameters:

- __Directory__: The local directory where CSV files will be written.

- __Update Interval__: The frequency with which we will fetch the full state of
  signalk, in other words, the "width" of the columns in the CSV.

- __Write Interval__: The frequency with which the CSV file is closed and a new
  one is rotated in.  In other words, the number of columns in the CSV.

- __Filter List__: Controls what signalk paths are published, the list either
  contains glob patterns describing the paths that should be included or
  excluded from publishing, for example, you might publish `"environment.*"`.

- __S3 Bucket__: You may optionally publish the produced CSVs to S3.  If this
  has a value, it is the bucket to be published to.  If this is set, then the
  local files are deleted after being successfully written to S3.

- __S3 Key Prefix__: All S3 keys will have this prefixed.  If you want this to
  appear to be a "folder" in S3, then the last character must be a '/'.

- __S3 Tags__: Tags to apply to objects uploaded to S3.

# Historical Data

In theory, this plugin could implement the history APIs.  It does not do so at
the moment.
