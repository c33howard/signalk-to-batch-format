# SignalK to CSV

SignalK plugin to produce periodic CSVs.

# Why CSV?

I want all my data in Amazon Timestream (ie in the cloud) for dashboarding and
later playback.  My boat's connectivity to the cloud comes from an LTE modem
with a data plan.  The LTE modem appears to be 95-99% available.  I have fixed
bandwidth per month.  Therefore, I want something that compresses really well,
and can deal with intermittent connectivity issues.

CSVs aren't perfect as far as data compression goes, but they're really good.
I've made each row a signalk path and each column a timestamp, so there's high
degree of repetition.  I'm currently producing around 1.2KB every 10s
compressed, which works out to around 320MB per month of data transfer.  (TODO,
I need to test on my actual boat and with 60s intervals.)

Having flat files on disk is extremely highly available.  Any connectivity
issues cause the file to stay put, and a sweeper can retry later on.  (The
sweeper is TODO)

# Bigger Picture

My setup is my local signalk runs and procduces CSVs.  These are uploaded to
S3.  I've notification running in Lambda that sees new files being written to
S3, it downloads the file, parses it, and writes to Timestream.

# Setup

If you're uploading to S3, then Signalk needs permissions to put objects in S3.
Configure this how you normally configure AWS.  The only permission required
should be S3:PutObject.

Note that if you're using an AWS config file, since this runs in node.js,
you'll need to set the environment variable `AWS_SDK_CONFIG_FILE`.

# Configuration

At the moment the plugin is hardcoded to only write `self`.  The configuration
consists of the following parameters

- __Directory__: The local directory where CSV files will be written

- __Update Interval__: The frequency with which we will fetch the full state of
  signalk, in other words, the "width" of the columns in the CSV.

- __Write Interval__: The frequency with which the CSV file is closed and a new
  one is rotated in.  In other words, the number of columns in the CSV.

- __Filter List__: Controls what signalk paths are published, the list either
  contains glob patterns describing the paths that should be included or
  excluded from publishing, for example, you might publish `"environment.*"`.

- __S3 Bucket__: You may optionally publish the produced CSVs to S3.  If this
  has a value, it is the bucket to be published to.

- __S3 Key Prefix__: All S3 keys will have this prefixed.  If you want this to
  appear to be a "folder" in S3, then the last character must be a '/'.

- __S3 Tags__: Tags to apply to objects uploaded to S3.

- __RM After Upload__: Controls whether or not the produced CSV files are kept
  locally.  This plugin never attempts to delete from S3.

# Historical Data

In theory, this plugin could implement the history APIs.  It does not do so at
the moment.
