const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, GetCommand, DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const s3Client = new S3Client({ region: process.env.S3_REGION || "us-east-1" });

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const sesClient = new SESClient({ region: "us-east-1" });
const { SNSClient, PublishCommand, CreatePlatformEndpointCommand, SetEndpointAttributesCommand, DeleteEndpointCommand } = require("@aws-sdk/client-sns");
const snsClient = new SNSClient({ region: "us-east-1" });

const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

// Helper: call Gemini predict API for images
async function callGeminiImage(prompt, aspectRatio) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey === "REPLACE_WITH_YOUR_KEY") {
    throw new Error("GEMINI_API_KEY environment variable is missing or invalid");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`;
  const payload = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio: aspectRatio || "1:1" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Image API ${res.status}: ${errText}`);
  }

  const result = await res.json();
  const predictions = result?.predictions || [];
  if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
    return {
      type: "image",
      mimeType: predictions[0].mimeType || "image/png",
      data: predictions[0].bytesBase64Encoded,
    };
  }
  throw new Error("No image data returned from Gemini Image API");
}

// Helper: call Gemini generateContent API. Returns { type: "image"|"text", ... }
async function callGemini(model, contents, generationConfig) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey === "REPLACE_WITH_YOUR_KEY") {
    throw new Error("GEMINI_API_KEY environment variable is missing or invalid");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = { contents };
  if (generationConfig) payload.generationConfig = generationConfig;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText}`);
  }

  const result = await res.json();
  const parts = result?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      return {
        type: "image",
        mimeType: part.inlineData.mimeType || "image/png",
        data: part.inlineData.data || "",
      };
    }
  }
  const textPart = parts.find((p) => typeof p.text === "string");
  return { type: "text", text: textPart?.text || "" };
}

// Helper to send push notification to a specific device
async function sendPushNotification(device, alertmessage, tableName) {
  let endpointArn = device.endpointArn;

  // Skip devices that don't have an endpoint registered
  if (!endpointArn) {
    console.log(`Skipping device ${device.id} because it has no endpointArn`);
    return;
  }

  const platform = (device.platform || "ios").toLowerCase();
  let publishParams;

  if (platform === "ios" || platform === "apple") {
    publishParams = {
      TargetArn: endpointArn,
      Message: JSON.stringify({
        APNS: JSON.stringify({
          aps: {
            alert: {
              title: "Worship",
              body: alertmessage,
            },
            sound: "default",
          },
        }),
      }),
      MessageStructure: "json",
    };
  } else if (platform === "android" || platform === "google") {
    // Standard FCM/GCM payload for Android
    publishParams = {
      TargetArn: endpointArn,
      Message: JSON.stringify({
        GCM: JSON.stringify({
          notification: {
            title: "Auth Exit",
            body: alertmessage,
            sound: "default",
          },
          data: {
            message: alertmessage,
          },
        }),
      }),
      MessageStructure: "json",
    };
  } else {
    console.log(`Unsupported platform ${platform} for device ${device.id}`);
    return;
  }

  try {
    return await snsClient.send(new PublishCommand(publishParams));
  } catch (error) {
    if (error.name === "EndpointDisabledException" || error.message.includes("Endpoint is disabled")) {
      console.log(`Endpoint ${endpointArn} is disabled. Deleting endpoint and removing from device record...`);

      // Delete the disabled endpoint
      try {
        await snsClient.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
      } catch (deleteError) {
        console.log(`Failed to delete endpoint ${endpointArn}:`, deleteError);
      }

      // Remove endpointArn from the database so it gets recreated next time
      if (tableName) {
        await dynamo.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { id: device.id },
            UpdateExpression: "REMOVE endpointArn",
          }),
        );
      }
      console.error(`Endpoint ${endpointArn} was disabled and has been cleared.`);
    } else {
      console.error(`Error publishing to ${endpointArn}:`, error);
      throw error;
    }
  }
}

async function resolveTableFromAdmin(event) {
  const adminTable = process.env.ADMIN_TABLE;
  let orgCode = event.pathParameters?.orgCode;

  const routeKey = event.resource || event.routeKey || event.requestContext?.routeKey || "";
  if (routeKey.includes("/admin") || orgCode === "admin") {
    return adminTable;
  }

  if (!orgCode) {
    throw new Error("orgCode not found in request");
  }

  // Query admin table to find org table
  const result = await dynamo.send(
    new QueryCommand({
      TableName: adminTable,
      IndexName: "type-index", // ensure this exists
      KeyConditionExpression: "#type = :type",
      FilterExpression: "#url = :url AND #isactive = :active",
      ExpressionAttributeNames: {
        "#type": "type",
        "#url": "url",
        "#isactive": "isactive",
      },
      ExpressionAttributeValues: {
        ":type": "organisation",
        ":url": orgCode,
        ":active": 1,
      },
    }),
  );

  if (!result.Items || result.Items.length === 0) {
    throw new Error(`No active organisation found for orgCode=${orgCode}`);
  }

  return result.Items[0].orgtablename;
}

// Helper: upload base64 image to S3 and return the S3 URL
async function uploadBase64ToS3(base64Data, fieldName, payloadId, orgCode) {
  const bucketName = process.env.BOOK_COVER_BUCKET || "temple";
  // Support both raw base64 and data URI format (data:image/png;base64,...)
  let imageBuffer;
  let contentType = "image/jpeg"; // default

  if (base64Data.startsWith("data:")) {
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (matches) {
      contentType = matches[1];
      imageBuffer = Buffer.from(matches[2], "base64");
    } else {
      throw new Error(`Invalid data URI format for ${fieldName}`);
    }
  } else {
    imageBuffer = Buffer.from(base64Data, "base64");
  }

  // Determine file extension from content type
  const extMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = extMap[contentType] || "jpg";
  const timestamp = Date.now();
  const itemId = payloadId || `item-${timestamp}`;
  const folder = orgCode ? `images/${orgCode}` : "images";
  const s3Key = `${folder}/${itemId}-${fieldName}-${timestamp}.${ext}`;

  console.log(`Uploading to S3 with key: ${s3Key}`);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );

  // Return the public S3 URL
  const bucketUrl = process.env.BUCKET_URL || `https://${bucketName}.s3.us-east-1.amazonaws.com`;
  return `${bucketUrl}/${s3Key}`;
}

// Helper: Extract S3 key from a full URL and delete the object
async function deleteS3ImageFromUrl(url) {
  if (!url || !url.includes(".amazonaws.com/")) return;

  try {
    const bucketName = process.env.BOOK_COVER_BUCKET || "temple";
    // URL format: https://bucket.s3.region.amazonaws.com/key
    const urlParts = url.split(".amazonaws.com/");
    if (urlParts.length < 2) return;

    const s3Key = urlParts[1];
    console.log(`Deleting old image from S3: ${s3Key}`);

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      }),
    );
  } catch (err) {
    console.error("Failed to delete old image from S3:", err);
    // We don't throw here to avoid failing the whole request if cleanup fails
  }
}

// Helper to process all potential image fields in an item
async function processItemImages(item, orgCode) {
  const imageFields = ["coverImage", "coverimage", "imageurl"];

  for (const field of imageFields) {
    const value = item[field];

    // Check if value is base64 data (not an existing URL)
    if (value && typeof value === "string" && !value.startsWith("http") && value.length > 50) {
      console.log(`Uploading ${field} to S3...`);
      item[field] = await uploadBase64ToS3(value, field, item.id, orgCode);
      console.log(`${field} uploaded:`, item[field]);
    }
  }

  return item;
}
// initialise dynamoDB client
exports.handler = async function (event, context) {
  let body;
  let statusCode = 200;

  const headers = {
    "Content-Type": "application/json",
  };
  try {
    console.log(event);
    console.log("Event Route Key: ", event.resource);
    if (event?.Records !== undefined && event?.Records[0]?.eventSource === "aws:sqs") {
      const requestJSON = JSON.parse(event.Records[0].body);
      // reuse same resolver
      const sqsOrgCode = requestJSON.orgCode;
      event.pathParameters = { orgCode: sqsOrgCode };
      const targetTable = await resolveTableFromAdmin(event);
      console.log("Writing to table:", targetTable);
      delete requestJSON.orgCode;
      delete requestJSON.tableName;
      console.log("Incoming message body from SQS : ", event);
      const { Records } = event;

      // Process images before saving
      await processItemImages(requestJSON, sqsOrgCode);

      await dynamo.send(
        new PutCommand({
          TableName: targetTable,
          Item: requestJSON,
        }),
      );
      statusCode = 200;
      body = JSON.parse(Records[0].body);
      console.log("SQS request Successfully written to DynamoDB");
    } else {
      const tableName = await resolveTableFromAdmin(event);
      const rawRoute = event.resource || event.routeKey || event.requestContext?.routeKey || "";
      const route = rawRoute.includes(" ") ? rawRoute.split(" ")[1] : rawRoute;

      console.log("Resolved Routing:", { rawRoute, route, tableName });

      // Shared JWT Verification Helper
      const verifyJwt = async (routeLabel = "api") => {
        const authHeader = event.headers?.authorization || event.headers?.Authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          console.log("Unauthorized: Missing or invalid token format", authHeader);
          throw new Error("Unauthorized: Missing or invalid token");
        }

        const token = authHeader.split(" ")[1];
        try {
          const { jwtVerify } = await import("jose");
          const secret = new TextEncoder().encode(process.env.JWT_SECRET);
          const { payload } = await jwtVerify(token, secret);

          console.log(`Token verified successfully for ${routeLabel}`);
          return payload;
        } catch (err) {
          console.log(`Token verification failed for ${routeLabel}:`, err.message);
          throw new Error(`Unauthorized: Token verification failed - ${err.message}`);
        }
      };

      switch (route) {
        case "/{orgCode}/itemsbytype/{id}":
          let queryType = event.pathParameters.id;
          let skipAuth = false;

          if (queryType === "organisation") {
            skipAuth = true;
          } else if (queryType === "student-login") {
            queryType = "student";
            skipAuth = true;
          } else if (queryType === "user-login") {
            queryType = "user";
            skipAuth = true;
          } else if (queryType === "otp") {
            skipAuth = true;
          } else if (queryType === "deity") {
            skipAuth = true;
          } else if (queryType === "priest") {
            skipAuth = true;
          } else if (queryType === "service") {
            skipAuth = true;
          } else if (queryType === "event") {
            skipAuth = true;
          } else if (queryType === "facility") {
            skipAuth = true;
          } else if (queryType === "timing") {
            skipAuth = true;
          } else if (queryType === "newsletter") {
            skipAuth = true;
          } else if (queryType === "gallery") {
            skipAuth = true;
          } else if (queryType === "campaign") {
            skipAuth = true;
          } else if (queryType === "committee") {
            skipAuth = true;
          } else if (queryType === "devotee") {
            skipAuth = true;
          }

          if (!skipAuth) {
            try {
              await verifyJwt("getitemsbytype");
            } catch (err) {
              statusCode = 401;
              body = { error: err.message };
              break;
            }
          }

          body = await dynamo.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "type-index",
              KeyConditionExpression: "#type = :type",
              ExpressionAttributeNames: {
                "#type": "type",
              },
              ExpressionAttributeValues: {
                ":type": queryType,
              },
            }),
          );
          body = body.Items;
          break;
        case "/{orgCode}/itemsbytypeanddate/{id}/{date}":
          const typeQuery = event.pathParameters.id;
          const dateQuery = event.pathParameters.date;

          try {
            await verifyJwt("itemsbytypeanddate");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          body = await dynamo.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "type-date-index",
              KeyConditionExpression: "#type = :type AND #date = :date",
              ExpressionAttributeNames: {
                "#type": "type",
                "#date": "date",
              },
              ExpressionAttributeValues: {
                ":type": typeQuery,
                ":date": dateQuery,
              },
            }),
          );
          body = body.Items;
          break;

        case "/{orgCode}/items/{id}":
          console.log("Incoming Get request:", event.pathParameters.id);
          const getresult = await dynamo.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                id: event.pathParameters.id,
              },
            }),
          );
          body = getresult.Item ? [getresult.Item] : [];
          break;
        case "/{orgCode}/removeitem/{id}":
          console.log("Incoming Delete request : ", event.pathParameters.id);

          try {
            await verifyJwt("removeitem");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          const itemIdToRemove = event.pathParameters.id;

          await dynamo.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                id: itemIdToRemove,
              },
            }),
          );
          body = `Deleted item ${itemIdToRemove}`;
          break;
        case "/{orgCode}/items/{column}/{value}":
          body = await dynamo.send(new ScanCommand({ TableName: tableName, FilterExpression: "contains(#columnname, :value)", ExpressionAttributeNames: { "#columnname": event.pathParameters.column }, ExpressionAttributeValues: { ":value": event.pathParameters.value } }));
          body = body.Items;
          break;
        case "/{orgCode}/items/filter2column":
          // Parse JSON body (make sure body is JSON-parsed)
          const requestBody = JSON.parse(event.body);

          try {
            //await verifyJwt("filter2column");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          const { column1, value1, column2, value2 } = requestBody;
          // Define the ScanCommand with FilterExpression for two conditions
          body = await dynamo.send(
            new ScanCommand({
              TableName: tableName,
              FilterExpression: "#column1 = :value1 AND #column2 = :value2",
              ExpressionAttributeNames: {
                "#column1": column1,
                "#column2": column2,
              },
              ExpressionAttributeValues: {
                ":value1": value1,
                ":value2": value2,
              },
            }),
          );
          body = body.Items;
          console.log("DD sucessfully filtered 2 column : ", requestBody);
          break;
        case "/{orgCode}/getsecrets":
          const secret_name = "prod/s3/ap-south";
          const responseobj = {};
          const client = new SecretsManagerClient();
          const secretData = await client.send(
            new GetSecretValueCommand({
              SecretId: secret_name,
            }),
          );

          const replaced = secretData.SecretString.replace(/['"{}]/g, "");
          const result = replaced.split(",");
          await Promise.all(
            result.map((item) => {
              const splitted = item.split(":");
              responseobj[splitted[0]] = splitted[1];
            }),
          );
          console.log("secretData retrived sucessfully");
          body = responseobj;
          break;
        case "/{orgCode}/sendemail":
          console.log("Incoming Send Email Request");

          const emailRequest = JSON.parse(event.body);
          const { subject, body: emailBody, sender, recipient, cc = [] } = emailRequest;

          if (!subject || !emailBody || !sender || !recipient) {
            statusCode = 400;
            body = { error: "Missing required fields: subject, body, sender, recipient" };
            break;
          }

          const command = new SendEmailCommand({
            Source: sender,
            Destination: {
              ToAddresses: [recipient],
              CcAddresses: Array.isArray(cc) ? cc : [cc],
            },
            Message: {
              Subject: { Data: subject },
              Body: {
                Html: { Data: emailBody },
              },
            },
          });

          try {
            const response = await sesClient.send(command);
            console.log("Email sent successfully:", response.MessageId);

            body = {
              status: "success",
              messageId: response.MessageId,
            };
          } catch (err) {
            console.error("SES send error:", err);
            statusCode = 500;
            body = {
              status: "failed",
              error: err.message,
            };
          }
          break;
        case "/{orgCode}/registerdevice":
          console.log("Incoming Register Device Request");
          const registerPayload = JSON.parse(event.body);

          if (!registerPayload.email || !registerPayload.orgCode || !registerPayload.token) {
            statusCode = 400;
            body = { error: "Missing required fields for device registration" };
            break;
          }

          const deviceId = registerPayload.id || `userdevice-${registerPayload.email}`;
          let generatedEndpointArn = null;

          // Attempt to create SNS Platform Endpoint
          try {
            const result = await snsClient.send(
              new CreatePlatformEndpointCommand({
                PlatformApplicationArn: process.env.PLATFORM_ARN,
                Token: registerPayload.token,
                CustomUserData: deviceId,
              }),
            );
            generatedEndpointArn = result.EndpointArn;
            console.log("SNS Endpoint created successfully:", generatedEndpointArn);
          } catch (createErr) {
            if (createErr.message && createErr.message.includes("already exists with the same Token")) {
              const match = createErr.message.match(/Endpoint (arn:aws:sns:[^ ]+) already/);
              if (match && match[1]) {
                generatedEndpointArn = match[1];
                console.log(`Endpoint already exists. Recovered endpointArn: ${generatedEndpointArn}`);

                // Ensure the existing endpoint is enabled and has correct metadata
                try {
                  await snsClient.send(
                    new SetEndpointAttributesCommand({
                      EndpointArn: generatedEndpointArn,
                      Attributes: {
                        Enabled: "true",
                        Token: registerPayload.token,
                        CustomUserData: deviceId,
                      },
                    }),
                  );
                  console.log(`Endpoint ${generatedEndpointArn} updated and enabled.`);
                } catch (updateErr) {
                  console.warn(`Failed to update/enable existing endpoint ${generatedEndpointArn}:`, updateErr.message);
                  // We continue anyway, as the endpoint still exists
                }
              } else {
                console.error("Error parsing existing EndpointArn", createErr);
                statusCode = 500;
                body = { error: "Failed to generate endpoint ARN", details: createErr.message };
                break;
              }
            } else {
              console.error("Error creating SNS endpoint", createErr);
              statusCode = 500;
              body = { error: "Failed to create SNS endpoint", details: createErr.message };
              break;
            }
          }

          // Build item to save in DynamoDB
          const deviceItem = {
            id: deviceId,
            email: registerPayload.email,
            role: registerPayload.roles ? registerPayload.roles.join(",") : registerPayload.role,
            orgCode: registerPayload.orgCode,
            token: registerPayload.token,
            platform: registerPayload.platform || "ios",
            type: registerPayload.type || "userdevice",
            endpointArn: generatedEndpointArn,
          };

          await dynamo.send(
            new PutCommand({
              TableName: tableName,
              Item: deviceItem,
            }),
          );

          body = { message: "Device registered successfully", id: deviceId, endpointArn: generatedEndpointArn };
          break;

        case "/{orgCode}/sendpush":
          console.log("Incoming Push Notification Request");
          const { role: rolePush, orgcode: orgPush, alertmessage } = JSON.parse(event.body);

          if (!rolePush || !orgPush || !alertmessage) {
            statusCode = 400;
            body = { error: "Missing required fields: role, orgcode, alertmessage" };
            break;
          }

          const roles = rolePush.split(",").map((r) => r.trim());

          const queryResult = await dynamo.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "type-index",
              KeyConditionExpression: "#type = :type",
              ExpressionAttributeNames: {
                "#type": "type",
              },
              ExpressionAttributeValues: {
                ":type": "userdevice",
              },
            }),
          );

          const devices = queryResult.Items ? queryResult.Items.filter((device) => device.role && roles.some((role) => device.role.includes(role))) : [];

          if (devices.length === 0) {
            body = { message: "No devices found" };
            break;
          }

          const publishPromises = devices.map((device) => sendPushNotification(device, alertmessage, tableName));

          await Promise.all(publishPromises);
          body = { message: "Notification sent" };
          break;

        case "/{orgCode}/sendpushUser":
          console.log("Incoming targeted Push Notification Request");
          const pushUserPayload = JSON.parse(event.body);
          const targetEmail = pushUserPayload.email;
          const targetMessage = pushUserPayload.message;

          if (!targetEmail || !targetMessage) {
            statusCode = 400;
            body = { error: "Missing required fields: email, message" };
            break;
          }

          const userDevicesResult = await dynamo.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "type-index",
              KeyConditionExpression: "#type = :type",
              ExpressionAttributeNames: {
                "#type": "type",
              },
              ExpressionAttributeValues: {
                ":type": "userdevice",
              },
            }),
          );

          // Filter by email in memory (case-insensitive)
          const userDevices = userDevicesResult.Items ? userDevicesResult.Items.filter((device) => device.email && targetEmail && device.email.toLowerCase() === targetEmail.toLowerCase()) : [];

          console.log(`Found ${userDevices.length} devices for user ${targetEmail}`);

          if (userDevices.length === 0) {
            body = { message: `No devices found for user ${targetEmail}` };
            break;
          }

          const userPushPromises = userDevices.map((device) => sendPushNotification(device, targetMessage, tableName));

          await Promise.all(userPushPromises);
          body = { message: `Notification sent to user ${targetEmail}` };
          break;
        case "/{orgCode}/saveitem":
          console.log("Incoming Save Item Request");

          try {
            await verifyJwt("saveitem");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          const saveItemPayload = JSON.parse(event.body);

          try {
            await processItemImages(saveItemPayload, event.pathParameters?.orgCode);
          } catch (uploadErr) {
            console.error("Failed to process images:", uploadErr);
            statusCode = 500;
            body = { error: "Failed to upload images", details: uploadErr.message };
            break;
          }

          // Save item to DynamoDB (with S3 URLs instead of base64)
          await dynamo.send(
            new PutCommand({
              TableName: tableName,
              Item: saveItemPayload,
            }),
          );

          console.log("Item saved successfully with S3 image URLs");
          body = { message: "Item saved successfully", id: saveItemPayload.id };
          break;

        case "/{orgCode}/create-ai-image-using-gemini": {
          try {
            await verifyJwt("create-ai-image-using-gemini");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          const aiImgPayload = JSON.parse(event.body || "{}");
          const imageDescription = (aiImgPayload.imagedescription || "").trim();
          const requestedSize = aiImgPayload.imagesize === "16:9" ? "16:9" : "1:1";

          if (!imageDescription) {
            statusCode = 400;
            body = { error: "imagedescription is required" };
            break;
          }

          const imagetype = (aiImgPayload.imagetype || "deity").trim().toLowerCase();
          const aspectText = requestedSize === "16:9" ? "16:9 widescreen aspect ratio" : "1:1 square aspect ratio";

          let imagePrompt = `Create a high-quality, photorealistic, devotional image of a Hindu temple subject: ${imageDescription}. The image must be reverent and traditional, with authentic South Indian / Indian Hindu temple iconography, intricate detail on deities, ornaments, garlands and ritual items, warm natural temple lighting (oil lamps, sunlight through gopuram), vibrant traditional colors (saffron, gold, red, deep blue), and a respectful, spiritual atmosphere. Do not include any text, captions, watermarks or logos. Render in ${aspectText}.`;

          if (imagetype === "facility") {
            imagePrompt = `Create a high-quality, photorealistic image of a Hindu temple facility: ${imageDescription}. The image must depict a clean, modern, yet culturally appropriate space suitable for an Indian temple environment (such as a hall, kitchen, parking, or community space), well-lit and functional, without any text, captions, watermarks or logos. Render in ${aspectText}.`;
          } else if (imagetype === "campaign") {
            imagePrompt = `Create a high-quality, photorealistic banner image for a Hindu temple event or campaign: ${imageDescription}. The image must be festive, inviting, and traditional, capturing the spiritual and communal atmosphere of a temple gathering, without any text, captions, watermarks or logos. Render in ${aspectText}.`;
          } else if (imagetype === "service") {
            imagePrompt = `Create a high-quality, photorealistic image representing a Hindu temple pooja service: ${imageDescription}. The image must be reverent, showing appropriate ritual items (like flowers, diyas, kalash, or havan) and a spiritual atmosphere, without any text, captions, watermarks or logos. Render in ${aspectText}.`;
          } else if (imagetype === "slider") {
            imagePrompt = `Create a high-quality, photorealistic widescreen banner image for a Hindu temple website slider highlighting: ${imageDescription}. The image must be visually striking, traditional, and welcoming, capturing the grand architecture or festive atmosphere of a temple, without any text, captions, watermarks or logos. Render in ${aspectText}.`;
          }

          const aiImgResult = await callGeminiImage(imagePrompt, requestedSize);

          if (aiImgResult.type !== "image") {
            statusCode = 502;
            body = { error: "Image generation failed; model returned text instead of image", details: aiImgResult.text };
            break;
          }

          body = {
            mime_type: aiImgResult.mimeType,
            image_base64: aiImgResult.data,
            image_data_uri: `data:${aiImgResult.mimeType};base64,${aiImgResult.data}`,
            imagesize: requestedSize,
          };
          break;
        }

        case "/{orgCode}/create-ai-description-using-gemini": {
          try {
            await verifyJwt("create-ai-description-using-gemini");
          } catch (err) {
            statusCode = 401;
            body = { error: err.message };
            break;
          }

          const aiDescPayload = JSON.parse(event.body || "{}");
          const aiTitle = (aiDescPayload.title || aiDescPayload.about || "").trim();

          if (!aiTitle) {
            statusCode = 400;
            body = { error: 'title is required (e.g. "about Ganesha")' };
            break;
          }

          const imagetype = (aiDescPayload.imagetype || "deity").trim().toLowerCase();

          let descPrompt = `Write a respectful, devotional description in approximately 30 words about the following Hindu temple topic: "${aiTitle}". Keep it informative, traditional, suitable for a temple website. Output plain text only (no markdown, no quotes).`;

          if (imagetype === "facility") {
            descPrompt = `Write a clear, professional description in approximately 30 words for the following temple facility: "${aiTitle}". Highlight its usefulness, capacity, or amenities in a welcoming tone suitable for a temple website. Output plain text only (no markdown, no quotes).`;
          } else if (imagetype === "campaign") {
            descPrompt = `Write an inviting and festive description in approximately 30 words for the following temple event: "${aiTitle}". Encourage devotees to participate and highlight the spiritual or community significance. Output plain text only (no markdown, no quotes).`;
          } else if (imagetype === "service") {
            descPrompt = `Write a respectful and concise description in approximately 30 words for the following temple pooja service: "${aiTitle}". Explain its spiritual benefit or purpose briefly. Output plain text only (no markdown, no quotes).`;
          } else if (imagetype === "slider") {
            descPrompt = `Write an engaging and welcoming announcement in approximately 30 words for a temple website homepage slider highlighting: "${aiTitle}". Encourage devotees to learn more or participate. Output plain text only (no markdown, no quotes).`;
          }

          const aiDescResult = await callGemini(GEMINI_TEXT_MODEL, [{ parts: [{ text: descPrompt }] }], { maxOutputTokens: 256, temperature: 0.6 });

          body = {
            title: aiTitle,
            description: (aiDescResult.text || "").trim(),
          };
          break;
        }

        default:
          throw new Error(`Unsupported route: "${event.routeKey}"`);
      }
    }
  } catch (err) {
    console.log("Lamba error", err.message);
    // Preserving 401 if it was explicitly set in the switch, otherwise default to 400
    if (statusCode !== 401) statusCode = 400;
    body = err.message;
  } finally {
    console.log("Lambda response", body);
    if (typeof body !== "string") {
      body = JSON.stringify(body);
    }
  }
  return {
    statusCode,
    body,
    headers,
  };
};
