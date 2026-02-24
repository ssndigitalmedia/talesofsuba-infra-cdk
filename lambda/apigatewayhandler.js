const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, GetCommand, DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const sesClient = new SESClient({ region: "us-east-1" });
const { SNSClient, PublishCommand, CreatePlatformEndpointCommand, SetEndpointAttributesCommand } = require("@aws-sdk/client-sns");
const snsClient = new SNSClient({ region: "us-east-1" });

async function resolveTableFromAdmin(event) {
  const adminTable = process.env.ADMIN_TABLE;
  let orgCode;
  // admin routes
  // org routes
  if (event.pathParameters?.orgCode) {
    orgCode = event.pathParameters.orgCode;
  }
  if (event.resource?.startsWith("/admin") || orgCode === "admin") {
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
      event.pathParameters = { orgCode: requestJSON.orgCode };
      const targetTable = await resolveTableFromAdmin(event);
      console.log("Writing to table:", targetTable);
      delete requestJSON.orgCode;
      delete requestJSON.tableName;
      console.log("Incoming message body from SQS : ", event);
      const { Records } = event;
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
      console.log("Resolved DynamoDB table:", tableName);
      console.log("tablename", tableName);
      switch (event.resource) {
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
          }

          // Token Verification Logic
          if (!skipAuth) {
            const authHeader = event.headers?.authorization || event.headers?.Authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
              statusCode = 401;
              body = { error: "Unauthorized: Missing or invalid token" };
              break;
            }

            const token = authHeader.split(" ")[1];
            try {
              const { jwtVerify } = await import("jose");
              const secret = new TextEncoder().encode(process.env.JWT_SECRET);
              await jwtVerify(token, secret);
              console.log("Token verified successfully for getitemsbytype");
            } catch (err) {
              console.log("Token verification failed:", err.message);
              statusCode = 401;
              body = { error: "Unauthorized: Token verification failed" };
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
          await dynamo.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                id: event.pathParameters.id,
              },
            }),
          );
          body = `Deleted item ${event.pathParameters.id}`;
          break;
        case "/{orgCode}/items/{column}/{value}":
          body = await dynamo.send(new ScanCommand({ TableName: tableName, FilterExpression: "contains(#columnname, :value)", ExpressionAttributeNames: { "#columnname": event.pathParameters.column }, ExpressionAttributeValues: { ":value": event.pathParameters.value } }));
          body = body.Items;
          break;
        case "/{orgCode}/items/filter2column":
          // Parse JSON body (make sure body is JSON-parsed)
          const requestBody = JSON.parse(event.body);
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
              })
            );
            generatedEndpointArn = result.EndpointArn;
            console.log("SNS Endpoint created successfully:", generatedEndpointArn);
          } catch (createErr) {
            if (createErr.message && createErr.message.includes("already exists with the same Token")) {
              const match = createErr.message.match(/Endpoint (arn:aws:sns:[^ ]+) already/);
              if (match && match[1]) {
                generatedEndpointArn = match[1];
                console.log(`Recovered existing endpointArn from error: ${generatedEndpointArn}`);
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
            role: registerPayload.roles ? registerPayload.roles.join(',') : registerPayload.role,
            orgCode: registerPayload.orgCode,
            token: registerPayload.token,
            platform: registerPayload.platform || 'ios',
            type: registerPayload.type || 'userdevice',
            endpointArn: generatedEndpointArn
          };

          await dynamo.send(
            new PutCommand({
              TableName: tableName,
              Item: deviceItem,
            })
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

          const roles = rolePush.split(",").map(r => r.trim());

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
            })
          );

          const devices = queryResult.Items ? queryResult.Items.filter(device =>
            device.role && roles.some(role => device.role.includes(role))
          ) : [];

          if (devices.length === 0) {
            body = { message: "No devices found" };
            break;
          }

          const publishPromises = devices.map(async (device) => {
            let endpointArn = device.endpointArn;

            // Skip devices that don't have an endpoint registered
            if (!endpointArn) {
              console.log(`Skipping device ${device.id} because it has no endpointArn`);
              return;
            }

            const publishParams = {
              TargetArn: endpointArn,
              Message: JSON.stringify({
                APNS: JSON.stringify({
                  aps: {
                    alert: {
                      title: "Auth Exit",
                      body: alertmessage,
                    },
                    sound: "default",
                  },
                }),
              }),
              MessageStructure: "json",
            };

            try {
              return await snsClient.send(new PublishCommand(publishParams));
            } catch (error) {
              if (error.name === "EndpointDisabledException" || error.message.includes("Endpoint is disabled")) {
                console.log(`Endpoint ${endpointArn} is disabled. Deleting endpoint and removing from device record...`);

                // Delete the disabled endpoint
                try {
                  const { DeleteEndpointCommand } = require("@aws-sdk/client-sns");
                  await snsClient.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
                } catch (deleteError) {
                  console.log(`Failed to delete endpoint ${endpointArn}:`, deleteError);
                }

                // Remove endpointArn from the database so it gets recreated next time
                await dynamo.send(
                  new UpdateCommand({
                    TableName: tableName,
                    Key: { id: device.id },
                    UpdateExpression: "REMOVE endpointArn"
                  })
                );

                console.error(`Endpoint ${endpointArn} was disabled and has been cleared.`);
                // We don't retry immediately here because if it's disabled, the token is likely invalid
                // and just re-enabling it usually fails again immediately.
              } else {
                console.error(`Error publishing to ${endpointArn}:`, error);
                throw error;
              }
            }
          });

          await Promise.all(publishPromises);
          body = { message: "Notification sent" };
          break;
        default:
          throw new Error(`Unsupported route: "${event.routeKey}"`);
      }
    }
  } catch (err) {
    console.log("Lamba error", err.message);
    statusCode = 400;
    body = err.message;
  } finally {
    console.log("Lambda response", body);
    body = JSON.stringify(body);
  }
  return {
    statusCode,
    body,
    headers,
  };
};
