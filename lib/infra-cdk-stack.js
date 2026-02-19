"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthExitAppInfraCdkStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const sqs = require("aws-cdk-lib/aws-sqs");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const logs = require("aws-cdk-lib/aws-logs");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const iam = require("aws-cdk-lib/aws-iam");
const lambda = require("aws-cdk-lib/aws-lambda");
const eventsources = require("aws-cdk-lib/aws-lambda-event-sources");
const cdk = require("aws-cdk-lib/core");
class AuthExitAppInfraCdkStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        //var project = "FaceCheckInApp-";
        //var project = "SplitEqualApp-";
        var project = "AuthExit-";
        var schoolNames = [];
        //const schoolNames = ["tal-", "school1", "school2", "school3"];
        //var project = "RecipeAIApp-";
        // var project = "TalesOfSuba-";
        // var project = "KnowUrCircle-";
        // var project = "SSNDigitalMedia-";
        // Could be per environment
        const corsOrigins = ["http://localhost:3000", "http://localhost:3001", "https://qa.authexit.org", "https://dev.authexit.org", "https://authexit.org", "https://www.authexit.org"];
        ////..................SQS QUEUES................./////////
        if (`${cdk.Stack.of(this).region}` == "us-east-1") {
            project = project;
            schoolNames = ["AuthExitAdmin-", "tal-", "testschool-", "school2", "school3", "school4"];
        }
        else if (`${cdk.Stack.of(this).region}` == "ap-south-1") {
            project = project + "qa-";
            schoolNames = ["AuthExitAdmin-", "testschool-"];
        }
        else {
            return;
        }
        ////..................SQS QUEUES................./////////
        // SQS DLQ
        const queueDlq = new sqs.Queue(this, `${project}DLQ`, {
            visibilityTimeout: aws_cdk_lib_1.Duration.seconds(300),
            queueName: `${project}DLQ`,
        });
        // SQS BufferingQueue
        const bufferingQueue = new sqs.Queue(this, `${project}bufferingQueue`, {
            visibilityTimeout: aws_cdk_lib_1.Duration.seconds(300),
            deadLetterQueue: {
                queue: queueDlq,
                maxReceiveCount: 1,
            },
            queueName: `${project}bufferingQueue`,
        });
        ////..................LOG Group................/////////
        const logGroup = new logs.LogGroup(this, `${project}Loggroup`, {
            retention: logs.RetentionDays.ONE_WEEK, // Set retention period for log events
        });
        ////..................DynamoDB................/////////
        const tables = {};
        for (const school of schoolNames) {
            const table = new dynamodb.Table(this, `${school}event-table`, {
                partitionKey: {
                    name: "id",
                    type: dynamodb.AttributeType.STRING,
                },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                tableName: `${school}EventTable`,
            });
            table.addGlobalSecondaryIndex({
                indexName: "type-index",
                partitionKey: {
                    name: "type",
                    type: dynamodb.AttributeType.STRING,
                },
                projectionType: dynamodb.ProjectionType.ALL,
            });
            tables[school] = table;
        }
        // UserDevices Table
        const userDevicesTable = new dynamodb.Table(this, `${project}UserDevices`, {
            partitionKey: {
                name: "id",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: "UserDevices",
        });
        userDevicesTable.addGlobalSecondaryIndex({
            indexName: "userKey-index",
            partitionKey: {
                name: "userKey",
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        ////..................Roles................/////////
        const APIGatewayHandlerLambdaExecutionRole = new iam.Role(this, `${project}APIGatewayHandlerLambdaExecutionRole`, {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            roleName: `${project}APIGatewayHandlerLambdaExecutionRole`,
        });
        // collect all table ARNs dynamically
        const allTableArns = [];
        for (const school of schoolNames) {
            const table = tables[school];
            allTableArns.push(table.tableArn); // main table
            allTableArns.push(`${table.tableArn}/index/*`); // GSI index
        }
        APIGatewayHandlerLambdaExecutionRole.attachInlinePolicy(new iam.Policy(this, `${project}APIGatewayHandlerInlinePolicy`, {
            statements: [
                new iam.PolicyStatement({
                    actions: ["dynamodb:List*", "dynamodb:DescribeReservedCapacity*", "dynamodb:DescribeLimits", "dynamodb:DescribeTimeToLive", "dynamodb:Get*", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query"],
                    resources: allTableArns,
                }),
                new iam.PolicyStatement({
                    actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                    resources: ["*"],
                }),
                new iam.PolicyStatement({
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: ["*"],
                }),
                new iam.PolicyStatement({
                    actions: ["ses:SendEmail", "ses:SendRawEmail"],
                    resources: ["*"],
                }),
                new iam.PolicyStatement({
                    actions: ["sns:Publish"],
                    resources: ["*"],
                }),
                new iam.PolicyStatement({
                    actions: ["dynamodb:Query"],
                    resources: [userDevicesTable.tableArn, `${userDevicesTable.tableArn}/index/*`],
                }),
            ],
        }));
        const ApiGwToSqsRole = new iam.Role(this, `${project}ApiGwV2ToSqsRole`, {
            assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            roleName: `${project}ApiGwV2ToSqsRole`,
        });
        ApiGwToSqsRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, "ApiGwPushCwPolicy", "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"));
        ApiGwToSqsRole.attachInlinePolicy(new iam.Policy(this, `${project}ApiGwV2ToSqsInlinePolicy`, {
            statements: [
                new iam.PolicyStatement({
                    actions: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:PurgeQueue", "sqs:DeleteMessage"],
                    resources: [bufferingQueue.queueArn],
                }),
            ],
        }));
        //Lambda - apigatewayhandlerFunction
        const ApiGatewayHandlerFunction = new lambda.Function(this, `${project}apigatewayhandler`, {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset("lambda"),
            handler: "apigatewayhandler.handler",
            functionName: `${project}apigatewayhandler`,
            role: APIGatewayHandlerLambdaExecutionRole,
            environment: {
                ADMIN_TABLE: tables["AuthExitAdmin-"].tableName,
                // add more if you onboard more schools
            },
        });
        const ApiGwToLambdaRole = new iam.Role(this, `${project}ApiGwToLambdaRole`, {
            assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            roleName: `${project}ApiGwToLambdaRole`,
        });
        ApiGwToLambdaRole.attachInlinePolicy(new iam.Policy(this, `${project}ApiGwToLambdaInlinePolicy`, {
            statements: [
                new iam.PolicyStatement({
                    actions: ["lambda:InvokeFunction", "secretsmanager:GetSecretValue"],
                    resources: [ApiGatewayHandlerFunction.functionArn],
                }),
                // Allow Lambda to send email via SES
                new iam.PolicyStatement({
                    actions: ["ses:SendEmail", "ses:SendRawEmail"],
                    resources: ["arn:aws:ses:us-east-1:287190273383:identity/support@authexit.org"], // * for all
                }),
            ],
        }));
        ////..................api Gateway................/////////
        const api = new apigwv2.CfnApi(this, `${project}HttpToSqs-API`, {
            corsConfiguration: {
                allowCredentials: false,
                allowHeaders: ["*"],
                allowMethods: ["GET", "POST", "PUT", "DELETE"],
                allowOrigins: corsOrigins,
                maxAge: 3600,
            },
            name: `${project}function`,
            protocolType: "HTTP",
        });
        const stage = new apigwv2.CfnStage(this, `${project}HttpToSqsStage`, {
            apiId: api.ref,
            stageName: "$default",
            autoDeploy: true,
            accessLogSettings: {
                destinationArn: logGroup.logGroupArn,
                format: '{ "requestId":"$context.requestId", "ip": "$context.identity.sourceIp", "requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod","routeKey":"$context.routeKey", "status":"$context.status","protocol":"$context.protocol", "responseLength":"$context.responseLength" }',
            },
        });
        const httpApiIntegSqsSendMessage = new apigwv2.CfnIntegration(this, `${project}httpApiIntegSqsSendMessage`, {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationSubtype: "SQS-SendMessage",
            payloadFormatVersion: "1.0",
            requestParameters: {
                QueueUrl: bufferingQueue.queueUrl,
                MessageBody: "$request.body",
            },
            credentialsArn: ApiGwToSqsRole.roleArn,
        });
        ////..................Lambda Function................/////////
        //Invoking Lambda after integrating with API Gateway
        const httpApiIntegInvokeLambda = new apigwv2.CfnIntegration(this, `${project}httpApiIntegInvokeLambda`, {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            //integrationSubtype: "LAMBDA",
            payloadFormatVersion: "1.0",
            credentialsArn: ApiGwToLambdaRole.roleArn, // Use the existing role or create a new one
            integrationUri: ApiGatewayHandlerFunction.functionArn,
        });
        const HttpApiRoute2 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg2`, {
            apiId: api.ref,
            routeKey: "GET /{orgCode}/itemsbytype/{id}",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute4 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg4`, {
            apiId: api.ref,
            routeKey: "GET /{orgCode}/items/{id}",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute5 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg5`, {
            apiId: api.ref,
            routeKey: "PUT /{orgCode}/items",
            target: `integrations/${httpApiIntegSqsSendMessage.ref}`,
        });
        const HttpApiRoute6 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg6`, {
            apiId: api.ref,
            routeKey: "POST /{orgCode}/items",
            target: `integrations/${httpApiIntegSqsSendMessage.ref}`,
        });
        const HttpApiRoute3 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg3`, {
            apiId: api.ref,
            routeKey: "DELETE /{orgCode}/removeitem/{id}",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute7 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute7`, {
            apiId: api.ref,
            routeKey: "POST /{orgCode}/getsecrets",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute10 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute10`, {
            apiId: api.ref,
            routeKey: "POST /{orgCode}/items/filter2column",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute11 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute11`, {
            apiId: api.ref,
            routeKey: "POST /{orgCode}/sendemail",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        const HttpApiRoute12 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute12`, {
            apiId: api.ref,
            routeKey: "POST /{orgCode}/sendpush",
            target: `integrations/${httpApiIntegInvokeLambda.ref}`,
        });
        // Associate the Lambda function with a CloudWatch Logs log group
        const lambdaLogGroup = new logs.LogGroup(this, "MyLambdaLogGroup", {
            logGroupName: "/aws/lambda/" + ApiGatewayHandlerFunction.functionName,
            retention: logs.RetentionDays.ONE_WEEK, // Set the desired retention period
        });
        //Add SQS as event source to trigger Lambda
        ApiGatewayHandlerFunction.addEventSource(new eventsources.SqsEventSource(bufferingQueue));
        const HttpApiLambdaPermission1 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission1`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/items/{id}`,
        });
        const HttpApiLambdaPermission2 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission2`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/itemsbytype/{id}`,
        });
        const HttpApiLambdaPermission4 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission4`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/getsecrets`,
        });
        const HttpApiLambdaPermission7 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission7`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/removeitem/{id}`,
        });
        const HttpApiLambdaPermission8 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission8`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/items/filter2column`,
        });
        const HttpApiLambdaPermission9 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission9`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/sendemail`,
        });
        const HttpApiLambdaPermission10 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission10`, {
            action: "lambda:InvokeFunction",
            functionName: ApiGatewayHandlerFunction.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/sendpush`,
        });
        ////..................Outputs................/////////
        new cdk.CfnOutput(this, `${project}HttpApiEndpoint`, {
            description: "API Endpoint",
            value: api.attrApiEndpoint,
        });
    }
}
exports.AuthExitAppInfraCdkStack = AuthExitAppInfraCdkStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5mcmEtY2RrLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaW5mcmEtY2RrLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLDZDQUEwRDtBQUMxRCwyQ0FBMkM7QUFDM0Msd0RBQXdEO0FBRXhELDZDQUE2QztBQUM3QyxxREFBcUQ7QUFDckQsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCxxRUFBcUU7QUFDckUsd0NBQXdDO0FBRXhDLE1BQWEsd0JBQXlCLFNBQVEsbUJBQUs7SUFDakQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN4QixrQ0FBa0M7UUFDbEMsaUNBQWlDO1FBQ2pDLElBQUksT0FBTyxHQUFHLFdBQVcsQ0FBQztRQUMxQixJQUFJLFdBQVcsR0FBYSxFQUFFLENBQUM7UUFDL0IsZ0VBQWdFO1FBQ2hFLCtCQUErQjtRQUMvQixnQ0FBZ0M7UUFDaEMsaUNBQWlDO1FBQ2pDLG9DQUFvQztRQUNwQywyQkFBMkI7UUFDM0IsTUFBTSxXQUFXLEdBQWEsQ0FBQyx1QkFBdUIsRUFBRSx1QkFBdUIsRUFBRSx5QkFBeUIsRUFBRSwwQkFBMEIsRUFBRSxzQkFBc0IsRUFBRSwwQkFBMEIsQ0FBQyxDQUFDO1FBQzVMLDBEQUEwRDtRQUMxRCxJQUFJLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLElBQUksV0FBVyxFQUFFLENBQUM7WUFDbEQsT0FBTyxHQUFHLE9BQU8sQ0FBQztZQUNsQixXQUFXLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFFM0YsQ0FBQzthQUFNLElBQUksR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENB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LENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxHQUFHLE9BQU8sMkJBQTJCLEVBQUU7WUFDdEcsTUFBTSxFQUFFLHVCQUF1QjtZQUMvQixZQUFZLEVBQUUseUJBQXlCLENBQUMsWUFBWTtZQUNwRCxTQUFTLEVBQUUsMEJBQTBCO1lBQ3JDLFNBQVMsRUFBRSx1QkFBdUIsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE9BQU8sSUFBSSxHQUFHLENBQUMsR0FBRyx5QkFBeUI7U0FDOUgsQ0FBQyxDQUFDO1FBRUgsc0RBQXNEO1FBQ3RELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxPQUFPLGlCQUFpQixFQUFFO1lBQ25ELFdBQVcsRUFBRSxjQUFjO1lBQzNCLEtBQUssRUFBRSxHQUFHLENBQUMsZUFBZTtTQUMzQixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUExVkQsNERBMFZDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFN0YWNrLCBTdGFja1Byb3BzIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBzcXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zcXNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGV2ZW50c291cmNlcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzXCI7XG5pbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcblxuZXhwb3J0IGNsYXNzIEF1dGhFeGl0QXBwSW5mcmFDZGtTdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG4gICAgLy92YXIgcHJvamVjdCA9IFwiRmFjZUNoZWNrSW5BcHAtXCI7XG4gICAgLy92YXIgcHJvamVjdCA9IFwiU3BsaXRFcXVhbEFwcC1cIjtcbiAgICB2YXIgcHJvamVjdCA9IFwiQXV0aEV4aXQtXCI7XG4gICAgdmFyIHNjaG9vbE5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIC8vY29uc3Qgc2Nob29sTmFtZXMgPSBbXCJ0YWwtXCIsIFwic2Nob29sMVwiLCBcInNjaG9vbDJcIiwgXCJzY2hvb2wzXCJdO1xuICAgIC8vdmFyIHByb2plY3QgPSBcIlJlY2lwZUFJQXBwLVwiO1xuICAgIC8vIHZhciBwcm9qZWN0ID0gXCJUYWxlc09mU3ViYS1cIjtcbiAgICAvLyB2YXIgcHJvamVjdCA9IFwiS25vd1VyQ2lyY2xlLVwiO1xuICAgIC8vIHZhciBwcm9qZWN0ID0gXCJTU05EaWdpdGFsTWVkaWEtXCI7XG4gICAgLy8gQ291bGQgYmUgcGVyIGVudmlyb25tZW50XG4gICAgY29uc3QgY29yc09yaWdpbnM6IHN0cmluZ1tdID0gW1wiaHR0cDovL2xvY2FsaG9zdDozMDAwXCIsIFwiaHR0cDovL2xvY2FsaG9zdDozMDAxXCIsIFwiaHR0cHM6Ly9xYS5hdXRoZXhpdC5vcmdcIiwgXCJodHRwczovL2Rldi5hdXRoZXhpdC5vcmdcIiwgXCJodHRwczovL2F1dGhleGl0Lm9yZ1wiLCBcImh0dHBzOi8vd3d3LmF1dGhleGl0Lm9yZ1wiXTtcbiAgICAvLy8vLi4uLi4uLi4uLi4uLi4uLi4uU1FTIFFVRVVFUy4uLi4uLi4uLi4uLi4uLi4uLy8vLy8vLy8vXG4gICAgaWYgKGAke2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb259YCA9PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICBwcm9qZWN0ID0gcHJvamVjdDtcbiAgICAgIHNjaG9vbE5hbWVzID0gW1wiQXV0aEV4aXRBZG1pbi1cIiwgXCJ0YWwtXCIsIFwidGVzdHNjaG9vbC1cIiwgXCJzY2hvb2wyXCIsIFwic2Nob29sM1wiLCBcInNjaG9vbDRcIl07XG5cbiAgICB9IGVsc2UgaWYgKGAke2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb259YCA9PSBcImFwLXNvdXRoLTFcIikge1xuICAgICAgcHJvamVjdCA9IHByb2plY3QgKyBcInFhLVwiO1xuICAgICAgc2Nob29sTmFtZXMgPSBbXCJBdXRoRXhpdEFkbWluLVwiLCBcInRlc3RzY2hvb2wtXCJdO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8vLy4uLi4uLi4uLi4uLi4uLi4uLlNRUyBRVUVVRVMuLi4uLi4uLi4uLi4uLi4uLi8vLy8vLy8vL1xuICAgIC8vIFNRUyBETFFcbiAgICBjb25zdCBxdWV1ZURscSA9IG5ldyBzcXMuUXVldWUodGhpcywgYCR7cHJvamVjdH1ETFFgLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogRHVyYXRpb24uc2Vjb25kcygzMDApLFxuICAgICAgcXVldWVOYW1lOiBgJHtwcm9qZWN0fURMUWAsXG4gICAgfSk7XG5cbiAgICAvLyBTUVMgQnVmZmVyaW5nUXVldWVcbiAgICBjb25zdCBidWZmZXJpbmdRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgYCR7cHJvamVjdH1idWZmZXJpbmdRdWV1ZWAsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwMCksXG4gICAgICBkZWFkTGV0dGVyUXVldWU6IHtcbiAgICAgICAgcXVldWU6IHF1ZXVlRGxxLFxuICAgICAgICBtYXhSZWNlaXZlQ291bnQ6IDEsXG4gICAgICB9LFxuICAgICAgcXVldWVOYW1lOiBgJHtwcm9qZWN0fWJ1ZmZlcmluZ1F1ZXVlYCxcbiAgICB9KTtcblxuICAgIC8vLy8uLi4uLi4uLi4uLi4uLi4uLi5MT0cgR3JvdXAuLi4uLi4uLi4uLi4uLi4uLy8vLy8vLy8vXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBgJHtwcm9qZWN0fUxvZ2dyb3VwYCwge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssIC8vIFNldCByZXRlbnRpb24gcGVyaW9kIGZvciBsb2cgZXZlbnRzXG4gICAgfSk7XG5cbiAgICAvLy8vLi4uLi4uLi4uLi4uLi4uLi4uRHluYW1vREIuLi4uLi4uLi4uLi4uLi4uLy8vLy8vLy8vXG4gICAgY29uc3QgdGFibGVzOiB7IFtrZXk6IHN0cmluZ106IGR5bmFtb2RiLlRhYmxlIH0gPSB7fTtcbiAgICBmb3IgKGNvbnN0IHNjaG9vbCBvZiBzY2hvb2xOYW1lcykge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgYCR7c2Nob29sfWV2ZW50LXRhYmxlYCwge1xuICAgICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICAgIH0sXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHRhYmxlTmFtZTogYCR7c2Nob29sfUV2ZW50VGFibGVgLFxuICAgICAgfSk7XG4gICAgICB0YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICAgIGluZGV4TmFtZTogXCJ0eXBlLWluZGV4XCIsXG4gICAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICAgIG5hbWU6IFwidHlwZVwiLFxuICAgICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgICB9LFxuICAgICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgICAgfSk7XG4gICAgICB0YWJsZXNbc2Nob29sXSA9IHRhYmxlO1xuICAgIH1cblxuICAgIC8vIFVzZXJEZXZpY2VzIFRhYmxlXG4gICAgY29uc3QgdXNlckRldmljZXNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBgJHtwcm9qZWN0fVVzZXJEZXZpY2VzYCwge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IFwiaWRcIixcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHRhYmxlTmFtZTogXCJVc2VyRGV2aWNlc1wiLFxuICAgIH0pO1xuXG4gICAgdXNlckRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IFwidXNlcktleS1pbmRleFwiLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IFwidXNlcktleVwiLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuICAgIC8vLy8uLi4uLi4uLi4uLi4uLi4uLi5Sb2xlcy4uLi4uLi4uLi4uLi4uLi4vLy8vLy8vLy9cblxuICAgIGNvbnN0IEFQSUdhdGV3YXlIYW5kbGVyTGFtYmRhRXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBgJHtwcm9qZWN0fUFQSUdhdGV3YXlIYW5kbGVyTGFtYmRhRXhlY3V0aW9uUm9sZWAsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICByb2xlTmFtZTogYCR7cHJvamVjdH1BUElHYXRld2F5SGFuZGxlckxhbWJkYUV4ZWN1dGlvblJvbGVgLFxuICAgIH0pO1xuICAgIC8vIGNvbGxlY3QgYWxsIHRhYmxlIEFSTnMgZHluYW1pY2FsbHlcbiAgICBjb25zdCBhbGxUYWJsZUFybnM6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IHNjaG9vbCBvZiBzY2hvb2xOYW1lcykge1xuICAgICAgY29uc3QgdGFibGUgPSB0YWJsZXNbc2Nob29sXTtcbiAgICAgIGFsbFRhYmxlQXJucy5wdXNoKHRhYmxlLnRhYmxlQXJuKTsgLy8gbWFpbiB0YWJsZVxuICAgICAgYWxsVGFibGVBcm5zLnB1c2goYCR7dGFibGUudGFibGVBcm59L2luZGV4LypgKTsgLy8gR1NJIGluZGV4XG4gICAgfVxuICAgIEFQSUdhdGV3YXlIYW5kbGVyTGFtYmRhRXhlY3V0aW9uUm9sZS5hdHRhY2hJbmxpbmVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeSh0aGlzLCBgJHtwcm9qZWN0fUFQSUdhdGV3YXlIYW5kbGVySW5saW5lUG9saWN5YCwge1xuICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wiZHluYW1vZGI6TGlzdCpcIiwgXCJkeW5hbW9kYjpEZXNjcmliZVJlc2VydmVkQ2FwYWNpdHkqXCIsIFwiZHluYW1vZGI6RGVzY3JpYmVMaW1pdHNcIiwgXCJkeW5hbW9kYjpEZXNjcmliZVRpbWVUb0xpdmVcIiwgXCJkeW5hbW9kYjpHZXQqXCIsIFwiZHluYW1vZGI6UHV0SXRlbVwiLCBcImR5bmFtb2RiOlVwZGF0ZUl0ZW1cIiwgXCJkeW5hbW9kYjpEZWxldGVJdGVtXCIsIFwiZHluYW1vZGI6U2NhblwiLCBcImR5bmFtb2RiOlF1ZXJ5XCJdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBhbGxUYWJsZUFybnMsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dHcm91cFwiLCBcImxvZ3M6Q3JlYXRlTG9nU3RyZWFtXCIsIFwibG9nczpQdXRMb2dFdmVudHNcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wic2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWVcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wic2VzOlNlbmRFbWFpbFwiLCBcInNlczpTZW5kUmF3RW1haWxcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wic25zOlB1Ymxpc2hcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wiZHluYW1vZGI6UXVlcnlcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt1c2VyRGV2aWNlc1RhYmxlLnRhYmxlQXJuLCBgJHt1c2VyRGV2aWNlc1RhYmxlLnRhYmxlQXJufS9pbmRleC8qYF0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgQXBpR3dUb1Nxc1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgYCR7cHJvamVjdH1BcGlHd1YyVG9TcXNSb2xlYCwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICByb2xlTmFtZTogYCR7cHJvamVjdH1BcGlHd1YyVG9TcXNSb2xlYCxcbiAgICB9KTtcblxuICAgIEFwaUd3VG9TcXNSb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbU1hbmFnZWRQb2xpY3lBcm4odGhpcywgXCJBcGlHd1B1c2hDd1BvbGljeVwiLCBcImFybjphd3M6aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BbWF6b25BUElHYXRld2F5UHVzaFRvQ2xvdWRXYXRjaExvZ3NcIikpO1xuXG4gICAgQXBpR3dUb1Nxc1JvbGUuYXR0YWNoSW5saW5lUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3kodGhpcywgYCR7cHJvamVjdH1BcGlHd1YyVG9TcXNJbmxpbmVQb2xpY3lgLCB7XG4gICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXCJzcXM6U2VuZE1lc3NhZ2VcIiwgXCJzcXM6UmVjZWl2ZU1lc3NhZ2VcIiwgXCJzcXM6UHVyZ2VRdWV1ZVwiLCBcInNxczpEZWxldGVNZXNzYWdlXCJdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbYnVmZmVyaW5nUXVldWUucXVldWVBcm5dLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vTGFtYmRhIC0gYXBpZ2F0ZXdheWhhbmRsZXJGdW5jdGlvblxuICAgIGNvbnN0IEFwaUdhdGV3YXlIYW5kbGVyRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGAke3Byb2plY3R9YXBpZ2F0ZXdheWhhbmRsZXJgLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcImxhbWJkYVwiKSxcbiAgICAgIGhhbmRsZXI6IFwiYXBpZ2F0ZXdheWhhbmRsZXIuaGFuZGxlclwiLFxuICAgICAgZnVuY3Rpb25OYW1lOiBgJHtwcm9qZWN0fWFwaWdhdGV3YXloYW5kbGVyYCxcbiAgICAgIHJvbGU6IEFQSUdhdGV3YXlIYW5kbGVyTGFtYmRhRXhlY3V0aW9uUm9sZSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFETUlOX1RBQkxFOiB0YWJsZXNbXCJBdXRoRXhpdEFkbWluLVwiXS50YWJsZU5hbWUsXG4gICAgICAgIC8vIGFkZCBtb3JlIGlmIHlvdSBvbmJvYXJkIG1vcmUgc2Nob29sc1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IEFwaUd3VG9MYW1iZGFSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIGAke3Byb2plY3R9QXBpR3dUb0xhbWJkYVJvbGVgLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgIHJvbGVOYW1lOiBgJHtwcm9qZWN0fUFwaUd3VG9MYW1iZGFSb2xlYCxcbiAgICB9KTtcblxuICAgIEFwaUd3VG9MYW1iZGFSb2xlLmF0dGFjaElubGluZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5KHRoaXMsIGAke3Byb2plY3R9QXBpR3dUb0xhbWJkYUlubGluZVBvbGljeWAsIHtcbiAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLCBcInNlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlXCJdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbkFybl0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgLy8gQWxsb3cgTGFtYmRhIHRvIHNlbmQgZW1haWwgdmlhIFNFU1xuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcInNlczpTZW5kRW1haWxcIiwgXCJzZXM6U2VuZFJhd0VtYWlsXCJdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXCJhcm46YXdzOnNlczp1cy1lYXN0LTE6Mjg3MTkwMjczMzgzOmlkZW50aXR5L3N1cHBvcnRAYXV0aGV4aXQub3JnXCJdLCAvLyAqIGZvciBhbGxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLy8vLi4uLi4uLi4uLi4uLi4uLi4uYXBpIEdhdGV3YXkuLi4uLi4uLi4uLi4uLi4uLy8vLy8vLy8vXG5cbiAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ3d2Mi5DZm5BcGkodGhpcywgYCR7cHJvamVjdH1IdHRwVG9TcXMtQVBJYCwge1xuICAgICAgY29yc0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgYWxsb3dDcmVkZW50aWFsczogZmFsc2UsXG4gICAgICAgIGFsbG93SGVhZGVyczogW1wiKlwiXSxcbiAgICAgICAgYWxsb3dNZXRob2RzOiBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCJdLFxuICAgICAgICBhbGxvd09yaWdpbnM6IGNvcnNPcmlnaW5zLFxuICAgICAgICBtYXhBZ2U6IDM2MDAsXG4gICAgICB9LFxuICAgICAgbmFtZTogYCR7cHJvamVjdH1mdW5jdGlvbmAsXG4gICAgICBwcm90b2NvbFR5cGU6IFwiSFRUUFwiLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5DZm5TdGFnZSh0aGlzLCBgJHtwcm9qZWN0fUh0dHBUb1Nxc1N0YWdlYCwge1xuICAgICAgYXBpSWQ6IGFwaS5yZWYsXG4gICAgICBzdGFnZU5hbWU6IFwiJGRlZmF1bHRcIixcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5nczoge1xuICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgIGZvcm1hdDogJ3sgXCJyZXF1ZXN0SWRcIjpcIiRjb250ZXh0LnJlcXVlc3RJZFwiLCBcImlwXCI6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIiwgXCJyZXF1ZXN0VGltZVwiOlwiJGNvbnRleHQucmVxdWVzdFRpbWVcIiwgXCJodHRwTWV0aG9kXCI6XCIkY29udGV4dC5odHRwTWV0aG9kXCIsXCJyb3V0ZUtleVwiOlwiJGNvbnRleHQucm91dGVLZXlcIiwgXCJzdGF0dXNcIjpcIiRjb250ZXh0LnN0YXR1c1wiLFwicHJvdG9jb2xcIjpcIiRjb250ZXh0LnByb3RvY29sXCIsIFwicmVzcG9uc2VMZW5ndGhcIjpcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIgfScsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgaHR0cEFwaUludGVnU3FzU2VuZE1lc3NhZ2UgPSBuZXcgYXBpZ3d2Mi5DZm5JbnRlZ3JhdGlvbih0aGlzLCBgJHtwcm9qZWN0fWh0dHBBcGlJbnRlZ1Nxc1NlbmRNZXNzYWdlYCwge1xuICAgICAgYXBpSWQ6IGFwaS5yZWYsXG4gICAgICBpbnRlZ3JhdGlvblR5cGU6IFwiQVdTX1BST1hZXCIsXG4gICAgICBpbnRlZ3JhdGlvblN1YnR5cGU6IFwiU1FTLVNlbmRNZXNzYWdlXCIsXG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogXCIxLjBcIixcbiAgICAgIHJlcXVlc3RQYXJhbWV0ZXJzOiB7XG4gICAgICAgIFF1ZXVlVXJsOiBidWZmZXJpbmdRdWV1ZS5xdWV1ZVVybCxcbiAgICAgICAgTWVzc2FnZUJvZHk6IFwiJHJlcXVlc3QuYm9keVwiLFxuICAgICAgfSxcbiAgICAgIGNyZWRlbnRpYWxzQXJuOiBBcGlHd1RvU3FzUm9sZS5yb2xlQXJuLFxuICAgIH0pO1xuXG4gICAgLy8vLy4uLi4uLi4uLi4uLi4uLi4uLkxhbWJkYSBGdW5jdGlvbi4uLi4uLi4uLi4uLi4uLi4vLy8vLy8vLy9cblxuICAgIC8vSW52b2tpbmcgTGFtYmRhIGFmdGVyIGludGVncmF0aW5nIHdpdGggQVBJIEdhdGV3YXlcblxuICAgIGNvbnN0IGh0dHBBcGlJbnRlZ0ludm9rZUxhbWJkYSA9IG5ldyBhcGlnd3YyLkNmbkludGVncmF0aW9uKHRoaXMsIGAke3Byb2plY3R9aHR0cEFwaUludGVnSW52b2tlTGFtYmRhYCwge1xuICAgICAgYXBpSWQ6IGFwaS5yZWYsXG4gICAgICBpbnRlZ3JhdGlvblR5cGU6IFwiQVdTX1BST1hZXCIsXG4gICAgICAvL2ludGVncmF0aW9uU3VidHlwZTogXCJMQU1CREFcIixcbiAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBcIjEuMFwiLFxuICAgICAgY3JlZGVudGlhbHNBcm46IEFwaUd3VG9MYW1iZGFSb2xlLnJvbGVBcm4sIC8vIFVzZSB0aGUgZXhpc3Rpbmcgcm9sZSBvciBjcmVhdGUgYSBuZXcgb25lXG4gICAgICBpbnRlZ3JhdGlvblVyaTogQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbkFybixcbiAgICB9KTtcblxuICAgIGNvbnN0IEh0dHBBcGlSb3V0ZTIgPSBuZXcgYXBpZ3d2Mi5DZm5Sb3V0ZSh0aGlzLCBgJHtwcm9qZWN0fUh0dHBBcGlSb3V0ZVNxc1NlbmRNc2cyYCwge1xuICAgICAgYXBpSWQ6IGFwaS5yZWYsXG4gICAgICByb3V0ZUtleTogXCJHRVQgL3tvcmdDb2RlfS9pdGVtc2J5dHlwZS97aWR9XCIsXG4gICAgICB0YXJnZXQ6IGBpbnRlZ3JhdGlvbnMvJHtodHRwQXBpSW50ZWdJbnZva2VMYW1iZGEucmVmfWAsXG4gICAgfSk7XG5cbiAgICBjb25zdCBIdHRwQXBpUm91dGU0ID0gbmV3IGFwaWd3djIuQ2ZuUm91dGUodGhpcywgYCR7cHJvamVjdH1IdHRwQXBpUm91dGVTcXNTZW5kTXNnNGAsIHtcbiAgICAgIGFwaUlkOiBhcGkucmVmLFxuICAgICAgcm91dGVLZXk6IFwiR0VUIC97b3JnQ29kZX0vaXRlbXMve2lkfVwiLFxuICAgICAgdGFyZ2V0OiBgaW50ZWdyYXRpb25zLyR7aHR0cEFwaUludGVnSW52b2tlTGFtYmRhLnJlZn1gLFxuICAgIH0pO1xuICAgIGNvbnN0IEh0dHBBcGlSb3V0ZTUgPSBuZXcgYXBpZ3d2Mi5DZm5Sb3V0ZSh0aGlzLCBgJHtwcm9qZWN0fUh0dHBBcGlSb3V0ZVNxc1NlbmRNc2c1YCwge1xuICAgICAgYXBpSWQ6IGFwaS5yZWYsXG4gICAgICByb3V0ZUtleTogXCJQVVQgL3tvcmdDb2RlfS9pdGVtc1wiLFxuICAgICAgdGFyZ2V0OiBgaW50ZWdyYXRpb25zLyR7aHR0cEFwaUludGVnU3FzU2VuZE1lc3NhZ2UucmVmfWAsXG4gICAgfSk7XG4gICAgY29uc3QgSHR0cEFwaVJvdXRlNiA9IG5ldyBhcGlnd3YyLkNmblJvdXRlKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaVJvdXRlU3FzU2VuZE1zZzZgLCB7XG4gICAgICBhcGlJZDogYXBpLnJlZixcbiAgICAgIHJvdXRlS2V5OiBcIlBPU1QgL3tvcmdDb2RlfS9pdGVtc1wiLFxuICAgICAgdGFyZ2V0OiBgaW50ZWdyYXRpb25zLyR7aHR0cEFwaUludGVnU3FzU2VuZE1lc3NhZ2UucmVmfWAsXG4gICAgfSk7XG4gICAgY29uc3QgSHR0cEFwaVJvdXRlMyA9IG5ldyBhcGlnd3YyLkNmblJvdXRlKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaVJvdXRlU3FzU2VuZE1zZzNgLCB7XG4gICAgICBhcGlJZDogYXBpLnJlZixcbiAgICAgIHJvdXRlS2V5OiBcIkRFTEVURSAve29yZ0NvZGV9L3JlbW92ZWl0ZW0ve2lkfVwiLFxuICAgICAgdGFyZ2V0OiBgaW50ZWdyYXRpb25zLyR7aHR0cEFwaUludGVnSW52b2tlTGFtYmRhLnJlZn1gLFxuICAgIH0pO1xuXG4gICAgY29uc3QgSHR0cEFwaVJvdXRlNyA9IG5ldyBhcGlnd3YyLkNmblJvdXRlKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaVJvdXRlN2AsIHtcbiAgICAgIGFwaUlkOiBhcGkucmVmLFxuICAgICAgcm91dGVLZXk6IFwiUE9TVCAve29yZ0NvZGV9L2dldHNlY3JldHNcIixcbiAgICAgIHRhcmdldDogYGludGVncmF0aW9ucy8ke2h0dHBBcGlJbnRlZ0ludm9rZUxhbWJkYS5yZWZ9YCxcbiAgICB9KTtcblxuICAgIGNvbnN0IEh0dHBBcGlSb3V0ZTEwID0gbmV3IGFwaWd3djIuQ2ZuUm91dGUodGhpcywgYCR7cHJvamVjdH1IdHRwQXBpUm91dGUxMGAsIHtcbiAgICAgIGFwaUlkOiBhcGkucmVmLFxuICAgICAgcm91dGVLZXk6IFwiUE9TVCAve29yZ0NvZGV9L2l0ZW1zL2ZpbHRlcjJjb2x1bW5cIixcbiAgICAgIHRhcmdldDogYGludGVncmF0aW9ucy8ke2h0dHBBcGlJbnRlZ0ludm9rZUxhbWJkYS5yZWZ9YCxcbiAgICB9KTtcbiAgICBjb25zdCBIdHRwQXBpUm91dGUxMSA9IG5ldyBhcGlnd3YyLkNmblJvdXRlKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaVJvdXRlMTFgLCB7XG4gICAgICBhcGlJZDogYXBpLnJlZixcbiAgICAgIHJvdXRlS2V5OiBcIlBPU1QgL3tvcmdDb2RlfS9zZW5kZW1haWxcIixcbiAgICAgIHRhcmdldDogYGludGVncmF0aW9ucy8ke2h0dHBBcGlJbnRlZ0ludm9rZUxhbWJkYS5yZWZ9YCxcbiAgICB9KTtcblxuICAgIGNvbnN0IEh0dHBBcGlSb3V0ZTEyID0gbmV3IGFwaWd3djIuQ2ZuUm91dGUodGhpcywgYCR7cHJvamVjdH1IdHRwQXBpUm91dGUxMmAsIHtcbiAgICAgIGFwaUlkOiBhcGkucmVmLFxuICAgICAgcm91dGVLZXk6IFwiUE9TVCAve29yZ0NvZGV9L3NlbmRwdXNoXCIsXG4gICAgICB0YXJnZXQ6IGBpbnRlZ3JhdGlvbnMvJHtodHRwQXBpSW50ZWdJbnZva2VMYW1iZGEucmVmfWAsXG4gICAgfSk7XG5cbiAgICAvLyBBc3NvY2lhdGUgdGhlIExhbWJkYSBmdW5jdGlvbiB3aXRoIGEgQ2xvdWRXYXRjaCBMb2dzIGxvZyBncm91cFxuICAgIGNvbnN0IGxhbWJkYUxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJNeUxhbWJkYUxvZ0dyb3VwXCIsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogXCIvYXdzL2xhbWJkYS9cIiArIEFwaUdhdGV3YXlIYW5kbGVyRnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssIC8vIFNldCB0aGUgZGVzaXJlZCByZXRlbnRpb24gcGVyaW9kXG4gICAgfSk7XG5cbiAgICAvL0FkZCBTUVMgYXMgZXZlbnQgc291cmNlIHRvIHRyaWdnZXIgTGFtYmRhXG4gICAgQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5hZGRFdmVudFNvdXJjZShuZXcgZXZlbnRzb3VyY2VzLlNxc0V2ZW50U291cmNlKGJ1ZmZlcmluZ1F1ZXVlKSk7XG5cbiAgICBjb25zdCBIdHRwQXBpTGFtYmRhUGVybWlzc2lvbjEgPSBuZXcgbGFtYmRhLkNmblBlcm1pc3Npb24odGhpcywgYCR7cHJvamVjdH1IdHRwQXBpTGFtYmRhUGVybWlzc2lvbjFgLCB7XG4gICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICBmdW5jdGlvbk5hbWU6IEFwaUdhdGV3YXlIYW5kbGVyRnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgcHJpbmNpcGFsOiBcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiLFxuICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb259OiR7Y2RrLlN0YWNrLm9mKHRoaXMpLmFjY291bnR9OiR7YXBpLnJlZn0vKi8qL3tvcmdDb2RlfS9pdGVtcy97aWR9YCxcbiAgICB9KTtcblxuICAgIGNvbnN0IEh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uMiA9IG5ldyBsYW1iZGEuQ2ZuUGVybWlzc2lvbih0aGlzLCBgJHtwcm9qZWN0fUh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uMmAsIHtcbiAgICAgIGFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgIGZ1bmN0aW9uTmFtZTogQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICBwcmluY2lwYWw6IFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIsXG4gICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn06JHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH06JHthcGkucmVmfS8qLyove29yZ0NvZGV9L2l0ZW1zYnl0eXBlL3tpZH1gLFxuICAgIH0pO1xuXG4gICAgY29uc3QgSHR0cEFwaUxhbWJkYVBlcm1pc3Npb240ID0gbmV3IGxhbWJkYS5DZm5QZXJtaXNzaW9uKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaUxhbWJkYVBlcm1pc3Npb240YCwge1xuICAgICAgYWN0aW9uOiBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgZnVuY3Rpb25OYW1lOiBBcGlHYXRld2F5SGFuZGxlckZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIHByaW5jaXBhbDogXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIixcbiAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufToke2Nkay5TdGFjay5vZih0aGlzKS5hY2NvdW50fToke2FwaS5yZWZ9LyovKi97b3JnQ29kZX0vZ2V0c2VjcmV0c2AsXG4gICAgfSk7XG5cbiAgICBjb25zdCBIdHRwQXBpTGFtYmRhUGVybWlzc2lvbjcgPSBuZXcgbGFtYmRhLkNmblBlcm1pc3Npb24odGhpcywgYCR7cHJvamVjdH1IdHRwQXBpTGFtYmRhUGVybWlzc2lvbjdgLCB7XG4gICAgICBhY3Rpb246IFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICBmdW5jdGlvbk5hbWU6IEFwaUdhdGV3YXlIYW5kbGVyRnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgcHJpbmNpcGFsOiBcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiLFxuICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb259OiR7Y2RrLlN0YWNrLm9mKHRoaXMpLmFjY291bnR9OiR7YXBpLnJlZn0vKi8qL3tvcmdDb2RlfS9yZW1vdmVpdGVtL3tpZH1gLFxuICAgIH0pO1xuICAgIGNvbnN0IEh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uOCA9IG5ldyBsYW1iZGEuQ2ZuUGVybWlzc2lvbih0aGlzLCBgJHtwcm9qZWN0fUh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uOGAsIHtcbiAgICAgIGFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgIGZ1bmN0aW9uTmFtZTogQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICBwcmluY2lwYWw6IFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIsXG4gICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn06JHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH06JHthcGkucmVmfS8qLyove29yZ0NvZGV9L2l0ZW1zL2ZpbHRlcjJjb2x1bW5gLFxuICAgIH0pO1xuICAgIGNvbnN0IEh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uOSA9IG5ldyBsYW1iZGEuQ2ZuUGVybWlzc2lvbih0aGlzLCBgJHtwcm9qZWN0fUh0dHBBcGlMYW1iZGFQZXJtaXNzaW9uOWAsIHtcbiAgICAgIGFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgIGZ1bmN0aW9uTmFtZTogQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICBwcmluY2lwYWw6IFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIsXG4gICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn06JHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH06JHthcGkucmVmfS8qLyove29yZ0NvZGV9L3NlbmRlbWFpbGAsXG4gICAgfSk7XG5cbiAgICBjb25zdCBIdHRwQXBpTGFtYmRhUGVybWlzc2lvbjEwID0gbmV3IGxhbWJkYS5DZm5QZXJtaXNzaW9uKHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaUxhbWJkYVBlcm1pc3Npb24xMGAsIHtcbiAgICAgIGFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgIGZ1bmN0aW9uTmFtZTogQXBpR2F0ZXdheUhhbmRsZXJGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICBwcmluY2lwYWw6IFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIsXG4gICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn06JHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH06JHthcGkucmVmfS8qLyove29yZ0NvZGV9L3NlbmRwdXNoYCxcbiAgICB9KTtcblxuICAgIC8vLy8uLi4uLi4uLi4uLi4uLi4uLi5PdXRwdXRzLi4uLi4uLi4uLi4uLi4uLi8vLy8vLy8vL1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGAke3Byb2plY3R9SHR0cEFwaUVuZHBvaW50YCwge1xuICAgICAgZGVzY3JpcHRpb246IFwiQVBJIEVuZHBvaW50XCIsXG4gICAgICB2YWx1ZTogYXBpLmF0dHJBcGlFbmRwb2ludCxcbiAgICB9KTtcbiAgfVxufVxuIl19