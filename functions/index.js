/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// [START import]
const functions = require('firebase-functions');
const gcs = require('@google-cloud/storage')();
const spawn = require('child-process-promise').spawn;
const admin = require('firebase-admin');
const adminSdkPrivateKey = require('./diggity-development-firebase-adminsdk-private-key.json');
const instagramConfig = require('./instagram-config.json');
const request = require('request');
const cors = require('cors')({origin: true});
// [END import]

const firebaseConfig = functions.config().firebase;
firebaseConfig.credential = admin.credential.cert(adminSdkPrivateKey);
admin.initializeApp(firebaseConfig);

// [START generateThumbnail]
/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 */
// [START generateThumbnailTrigger]
exports.generateThumbnail = functions.storage.object().onChange(event => {
    // [END generateThumbnailTrigger]
    // [START eventAttributes]
    const object = event.data; // The Storage object.

    const fileBucket = object.bucket; // The Storage bucket that contains the file.
    const filePath = object.name; // File path in the bucket.
    const contentType = object.contentType; // File content type.
    console.log("File Content Type: " + contentType);

    // Declare default file extension.
    let fileExtn = ".png";

    // Check content type to set file extension.
    if (contentType) {
        switch (contentType.toLowerCase()) {
            case "image/png":
                fileExtn = ".png"
                break;

            case "image/bmp":
                fileExtn = ".bmp"
                break;

            case "image/gif":
                fileExtn = ".gif"
                break;

            case "image/jpeg":
            case "image/jpg":
                fileExtn = ".jpg"
                break;

            case "image/tiff":
            case "image/x-tiff":
                fileExtn = ".tiff"
                break;
        }
    }
    const resourceState = object.resourceState; // The resourceState is 'exists' or 'not_exists' (for file/folder deletions).
    // [END eventAttributes]

    // [START stopConditions]
    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith('image/')) {
        console.log('This is not an image.');
        return;
    }

    // Get the file name.
    const fileName = filePath.split('/').pop();
    // Exit if the image is already a thumbnail.
    if (fileName.startsWith('thumb_')) {
        console.log('Already a Thumbnail.');
        return;
    }

    // Exit if this is a move or deletion event.
    if (resourceState === 'not_exists') {
        console.log('This is a deletion event.');
        return;
    }
    // [END stopConditions]

    // [START thumbnailGeneration]
    // Download file from bucket.
    const bucket = gcs.bucket(fileBucket);
    const tempFilePath = `/tmp/${fileName}.${fileExtn}`;
    return bucket.file(filePath).download({
        destination: tempFilePath
    }).then(() => {
        console.log('Image downloaded locally to', tempFilePath);
        // Generate a thumbnail using ImageMagick.
        return spawn('convert', [tempFilePath, '-thumbnail', '200x200>', tempFilePath]).then(() => {
            console.log('Thumbnail created at', tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + '/' + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });
    });
    // [END thumbnailGeneration]
});
// [END generateThumbnail]

// [START handleInstagramLogin]
/**
 * Handle Instagram login.
 */
// [START handleInstagramLoginTrigger]
exports.handleInstagramLogin = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req && req.query && req.query.code) {
            let islinking = req.query.uid ? true : false;

            let promiseFirebaseUserRecordForLinking = Promise.resolve({});
            if (islinking) {
                promiseFirebaseUserRecordForLinking = admin.auth().getUser(req.query.uid).then((userRecord) => {
                    if (userRecord) {
                        return Promise.resolve(userRecord);
                    } else {
                        return Promise.resolve(null);
                    }
                }).catch(() => {
                    return Promise.resolve(null);
                });
            }
            promiseFirebaseUserRecordForLinking.then(firebaseUserRecordForLinking => {
                if (firebaseUserRecordForLinking) {
                    let instagramAuthCode = req.query.code;

                    request.post({
                        url: instagramConfig.instagramOauthUrl,
                        form: {
                            client_id: instagramConfig.instagramClientId,
                            client_secret: instagramConfig.instagramClientSecret,
                            grant_type: "authorization_code",
                            redirect_uri: instagramConfig.redirectUrl,
                            code: instagramAuthCode
                        }
                    }, function (error, response, body) {
                        let isBodyParseable = true;

                        try {
                            body = JSON.parse(body);
                        } catch(e) {
                            isBodyParseable = false;
                        }

                        if (isBodyParseable) {
                            if (!error && response && response.statusCode === 200 && body && body.access_token && body.user && body.user.id) {
                                let instagramUserId = body.user.id;

                                admin.database().ref("/instagramIdentities/" + instagramUserId).once("value").then(function (snapshot) {
                                    let instagramIdentity = snapshot.val();

                                    if (islinking && instagramIdentity) {
                                        res.status(200).send({ instagramUserAlreadyExists: true });
                                    } else {
                                        let firebaseUserId = (islinking ? req.query.uid : (instagramIdentity && instagramIdentity.firebaseUserId ? instagramIdentity.firebaseUserId : "instagramUserId::" + instagramUserId));

                                        let updates = {};
                                        updates["/instagramIdentities/" + instagramUserId] = {
                                            accessToken: body.access_token,
                                            firebaseUserId: firebaseUserId,
                                            user: body.user
                                        };
                                        updates["/userInstagramIdentities/" + firebaseUserId] = {
                                            instagramUserId: instagramUserId
                                        };

                                        admin.database().ref().update(updates).then(() => {
                                            let isUserPropertiesFound = false;
                                            let userProperties = {};

                                            if ((!firebaseUserRecordForLinking.displayName || firebaseUserRecordForLinking.displayName === "") && body.user.full_name) {
                                                userProperties.displayName = body.user.full_name;
                                                isUserPropertiesFound = true;
                                            }
                                            if ((!firebaseUserRecordForLinking.photoURL || firebaseUserRecordForLinking.photoURL === "") && body.user.profile_picture) {
                                                userProperties.photoURL = body.user.profile_picture;
                                                isUserPropertiesFound = true;
                                            }

                                            let promiseUpdateOrCreateFirebaseUser = Promise.resolve();
                                            if (isUserPropertiesFound) {
                                                promiseUpdateOrCreateFirebaseUser = admin.auth().updateUser(firebaseUserId, userProperties).catch(error => {
                                                    if (!islinking && error.code === "auth/user-not-found") {
                                                        userProperties.uid = firebaseUserId;

                                                        return admin.auth().createUser(userProperties).catch(() => {
                                                            return Promise.resolve();
                                                        });
                                                    } else {
                                                        return Promise.resolve();
                                                    }
                                                });
                                            }

                                            promiseUpdateOrCreateFirebaseUser.then(() => {
                                                if (islinking) {
                                                    res.status(200).send({ islinked: true });
                                                } else {
                                                    admin.auth().createCustomToken(firebaseUserId).then((customToken) => {
                                                        res.status(200).send({ token: customToken });
                                                    }).catch(() => {
                                                        res.status(200).send({ error: true });
                                                    });
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    }
                                }).catch(() => {
                                    res.status(200).send({ error: true });
                                });
                            } else if (body && body.error_message) {
                                res.status(200).send({ message: body.error_message });
                            } else {
                                res.status(200).send({ error: true });
                            }
                        } else {
                            res.status(200).send({ error: true });
                        }
                    });
                } else {
                    res.status(200).send({ error: true });
                }
            });
        } else {
            res.status(200).send({ error: true });
        }
    });
});
// [END handleInstagramLoginTrigger]
// [END handleInstagramLogin]