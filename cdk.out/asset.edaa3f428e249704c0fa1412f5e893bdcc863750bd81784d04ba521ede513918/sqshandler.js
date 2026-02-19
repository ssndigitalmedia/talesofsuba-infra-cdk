//const aws = require('aws-sdk');

const { DynamoDBClient } = require ('@aws-sdk/client-dynamodb')
const {DynamoDBDocumentClient, PutCommand } = require ('@aws-sdk/lib-dynamodb')

//import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
//import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const tableName = process.env.table;


// initialise dynamoDB client
exports.handler = async function (event, context) {
  try{
      console.log('event: ', event);
      // event has propety called "Records"
     const { Records } = event;
      // parse the message into json object:
      const requestJSON = JSON.parse(Records[0].body); 
      //const requestJSON = event;
      console.log('requestJSON: ', requestJSON);
      // logs the body which is message
      console.log("Incoming message body from SQS :", requestJSON); 
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: requestJSON,
          })
        );
       console.log('Successfully written to DynamoDB');
     
  } catch(error){     
      console.error('Error in executing lambda: ', error);
      return {"statusCode": 500, "message:": "Error while execution"};
  }
};