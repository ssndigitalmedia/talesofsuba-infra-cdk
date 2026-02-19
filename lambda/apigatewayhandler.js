const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, GetCommand, DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const sesClient = new SESClient({ region: "us-east-1" });
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
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
          body = await dynamo.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "type-index",
              KeyConditionExpression: "#type = :type",
              ExpressionAttributeNames: {
                "#type": "type",
              },
              ExpressionAttributeValues: {
                ":type": event.pathParameters.id,
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

          const publishPromises = devices.map((device) => {
            return snsClient.send(
              new PublishCommand({
                TargetArn: device.endpointArn,
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
              })
            );
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
