# SignalK to Batch Format

SignalK plugin to produce periodic (compressed) batched json files.

# Why Batched Files on Disk?

I want all my data in Amazon Timestream (ie in the cloud) for dashboarding and
later playback.  My boat's connectivity to the cloud comes from an LTE modem
with a data plan.  The LTE modem appears to be 95-99% available and I have fixed
bandwidth per month.  Therefore, I want something that compresses really well,
and can deal with intermittent connectivity issues.

Having flat files on disk is extremely highly available.  Any connectivity
issues cause the file to stay put, and a sweeper can retry later on.  It
currently does a scan every 10 minutes and re-uploads everything that's been
sitting on disk for 10x the upload interval.

A batched format allows multiple data points per-key.  This allows the eventual
consumer of the file to efficiently see all the intermediate values and operate
on them however it pleases.  In the case of a time series datastore, like
Amazon Timestream, all the intermediate values can be durably stored.

# Why Not...

Direct write to Timestream, because there isn't a good way to get the latest
data most of the time, but get backfills after lost connectivity.  Data
compression was also an issue for LTE usage.

Signalk to signalk.  I tried a signalk on the boat and a signalk in the cloud,
but I ruled that out, because connectivity gaps meant that I missed data.
Additionally, this batch format led to much less data transfer, even after
compressing both.

AWS IOT or MQTT.  I ruled that out, because of how the data was transformed to
MQTT and sent immediately, which led to *much* higher data transfer.  Each data
point was sent as a complete message, including both the path and the data
value.  The real savings is due to the batching, and sending each path once
per-batch.  The MQTT can deal with connectivity gaps with a local buffer on the
boat, and indeed, AWS IOT does this by default.

# What are the Downsides?

This still doesn't deal well with object values in the signalk spec.  I've
converted each value in the object to a separate path.  This leads to better
compression and is, in my opinion, more flexible.

When there are multiple sources for a path, the signalk spec "blesses" one of
them and puts its value in the top level of the json object.  The rest of the
sources are "pushed down".  This promotion of a single source is a policy
decision at the source.  I've removed that and treated all sources equally.
When there are multiple sources, it's up the consumer to select which source to
read for a path.  I considered adding a "primary-$source" style key to the
format, where the value would be the name of the $source that signalk had
promoted, but decided against it for now.

# Bigger Picture

My setup is that I have a signalk on a raspberry pi running on my boat which
procduces batched json files.  These are uploaded to S3.  S3 is configured to
send an SNS notification on new object upload.  I have a lambda script
connected to that notification (see signalk-to-timestream-lambda) that writes
the batch to Timestream.  Additionally, I put the SNS message in an SQS queue,
so that a signalk instance running on an EC2 instance can replicate the data
(see signalk-from-batch-format).  This allows me to do things like anchor watch
when I'm away from the boat.  I could connect my phone to the signalk on the
boat, but then I'd have to expose the signalk to the outside world, and I'd
have a variable amount of data transfer from the boat.  This approach keeps the
data transfer off the boat constant.  Constant work is almost always a
desirable property.

Because I have two consumers of the files in S3 (Lambda and signalk), I can't
let either one delete the file in S3 upon completion, so I'm relying on an S3
lifecycle policy to delete the files after 24 hours.  This implies that my
playback window is 24hrs.

An HTTP PUT of the json files to a web server that does the write to Timestream
would also work, but S3 is more highly available, and one file per-minute fits
comfortably within the Lambda free-tier, so S3 ends up being both more
available and cheaper.

# Metrics

I have about 80 different data points being produced from signalk.  I take a
sample every 5s and produce a file every 1m.  Each comporessed json file
averages about 5.7KB.  That's around 250MB data transfer per-month, which is
well within my LTE monthly budget.

As far as costs go, my AWS bill for the project is around $4/month, almost all
of which is Timestream.  I'm paying $2/month for Timestream data ingestion and
$2/month for a grafana alarm that is constantly querying Timestream.  When I
was just ad-hoc rendering the dashboard, rather than constantly querying it for
alarming purposes, the query cost was almost $0.  My usage fits within the
Lambda, and SQS free tiers, and SNS costs $0.01/month.  The S3 costs are in the
$0.20 ballpark, as costs are dominated by requests, not storage.

I'm reusing an EC2 instance (t3a.small) I already had for signalk in the cloud.
I'm still running influxdb there, which I may turn off.  That's all on the same
instance, so the incremental cost is $0.  I like using the hosted Timestream,
since I trust it to not lose my data more than I trust myself, but if you have
a cloud instance already, then your monthly costs will be closer to $0.25/month
plus whatever instance you're using.

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
policy for the json files uploaded, or have the Lambda delete the file upon
completion.

# Configuration

At the moment the plugin is hardcoded to only write `self`.  (That means no AIS
contacts will be persisted.  AIS contacts add a *lot* more data to store and
transfer.)

The configuration consists of the following parameters:

- __Directory__: The local directory where the json files will be written.

- __Update Interval__: The frequency with which we will fetch the full state of
  signalk, in other words, the minimum time between data points in the output
  file

- __Publish Interval__: The frequency with which the json file is closed and a
  new one is rotated in.  In other words, the maximum time span encompassed in
  a single file.

- __Filter List__: Controls what signalk paths are published, the list either
  contains glob patterns describing the paths that should be included or
  excluded from publishing, for example, you might publish `"environment.*"`.

- __S3 Bucket__: You may optionally publish the produced files to S3.  If this
  has a value, it is the bucket to be published to.  If this is set, then the
  local files are deleted after being successfully written to S3.

- __S3 Key Prefix__: All S3 keys will have this prefixed.  If you want this to
  appear to be a "folder" in S3, then the last character must be a '/'.

- __S3 Tags__: Tags to apply to objects uploaded to S3.

# Historical Data

In theory, this plugin could implement the history APIs.  It does not do so at
the moment.
