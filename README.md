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
compression was also an issue for LTE usage.

Signalk to signalk.  I tried a signalk on the boat and a signalk in the cloud,
but I ruled that out, because connectivity gaps meant that I missed data.
Additionally, CSVs led to much less data transfer, even after compressing both.

AWS IOT or MQTT.  I ruled that out, because of how the data was transformed to
MQTT and sent immediately, which led to *much* higher data transfer.  Each
data point was sent as a complete message, including both the path and the
data value.  The real savings from the CSV approach is due to the batching,
and sending each path once per-batch.  The MQTT can deal with connectivity gaps
with a local buffer on the boat, and indeed, AWS IOT does this by default.

# What are the Downsides?

This doesn't deal too well with values that are objects.  I've special cased
the ones that affect me and there's nothing preventing more special casing.
But, as far as I can tell, the signalk specification doesn't provide a good
way to generically deal with these types, on the import side at least.

The current setup assumes that all data points are present and emitting for
the entire time window that is represented by the CSV file.  As a result,
if you have devices that frequently come and go, then this plugin will not
work well.  This is probably fixable, but would require some major surgery.

# Bigger Picture

My setup is that I have a signalk on a raspberry pi running on my boat which
procduces CSVs.  These are uploaded to S3.  S3 is configured to send an SNS
notification on new object upload.  I have a lambda script connected to that
notification (see signalk-to-timestream-lambda) that writes the batch to
Timestream.  Additionally, I put the SNS message in an SQS queue, so that a
signalk instance running on an EC2 instance can replicate the data (see
signalk-from-csv).  This allows me to do things like anchor watch when I'm
away from the boat.  I could connect my phone to the signalk on the boat, but
then I'd have to expose the signalk to the outside world, and I'd have a
variable amount of data transfer from the boat.  This approach keeps the data
transfer constant.

Because I have two consumers of the files in S3 (Lambda and signalk), I can't
let either one delete the file in S3 upon completion, so I'm relying on an S3
lifecycle policy to delete the files after 24 hours.  This implies that my
playback window is 24hrs.

An HTTP PUT of the CSVs to a web server that does the write to Timestream would
also work, but S3 is more highly available, and one file per-minute fits
comfortably within the Lambda free-tier, so S3 ends up being both more
available and cheaper.

As far as costs go, my AWS bill for the project is around $3/month.  This is
mostly $2/month for Timestream and $1/month for KMS, because I'm using my own
key, instead of an AWS provided key.  I'll probably migrate to using an AWS
provided key.  My usage fits within the Lambda, and SQS free tiers, and SNS
costs $0.01/month.  I'm reusing an EC2 instance I already had for signalk
in the cloud and the S3 storage costs are neglible (but again, blended with
some existing S3 usage, so I can't be too precise.)

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

- __Sources__: If this is true, then the $source name is written to the CSV (but
  not the full source object that $source refers to).  This must be true if you
  have multiple devices that emit the same signalk path and you want to see
  both.

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
