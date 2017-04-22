
## Introduction

Diggity NodeJS app for executing functions on FiB Cloud to generate thumbnails on real-time image upload.

## Overview

The thumbnail generation is performed using ImagMagick which is installed by default on all Cloud Functions instances. This is a CLI so we execute the command from node using the [child-process-promise](https://www.npmjs.com/package/child-process-promise) package. The image is first downloaded locally from the Cloud Storage bucket to the `tmp` folder using the [google-cloud](https://github.com/GoogleCloudPlatform/google-cloud-node) SDK.

## Trigger rules

The function triggers on upload of any file to your FiB project's default Cloud Storage bucket.