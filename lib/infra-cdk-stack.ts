import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as cdk from "aws-cdk-lib/core";
import * as s3 from "aws-cdk-lib/aws-s3";

export class RecipeAIeAppInfraCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    var project = "RecipeAIApp-";
    const tableNames = ["RecipeAIApp-"];
    // Could be per environment
    const corsOrigins: string[] = ["http://localhost:3000", "http://localhost:3001", "http://192.168.1.160:3000", "http://192.168.1.160:3001", "https://recipeai.eshope.com", "https://qarecipeai.eshope.com"];
    ////..................SQS QUEUES................./////////
    if (`${cdk.Stack.of(this).region}` == "us-east-1") {
      project = project;
    } else if (`${cdk.Stack.of(this).region}` == "ap-south-1") {
      project = project + "qa-";
    } else {
      return;
    }
    ////..................SQS QUEUES................./////////
    // SQS DLQ
    const queueDlq = new sqs.Queue(this, `${project}DLQ`, {
      visibilityTimeout: Duration.seconds(300),
      queueName: `${project}DLQ`,
    });

    // SQS BufferingQueue
    const bufferingQueue = new sqs.Queue(this, `${project}bufferingQueue`, {
      visibilityTimeout: Duration.seconds(300),
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
    const tables: { [key: string]: dynamodb.Table } = {};
    for (const school of tableNames) {
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
      table.addGlobalSecondaryIndex({
        indexName: "email-index",
        partitionKey: {
          name: "email",
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      tables[school] = table;
    }

    ////..................S3 Buckets................/////////
    const bucketName = process.env.RECIPE_BUCKET_NAME || "ssndigitalmedia";
    const recipeBucket = s3.Bucket.fromBucketName(this, `${project}RecipeImagesBucket`, bucketName);

    ////..................Roles................/////////

    const APIGatewayHandlerLambdaExecutionRole = new iam.Role(this, `${project}APIGatewayHandlerLambdaExecutionRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: `${project}APIGatewayHandlerLambdaExecutionRole`,
    });
    // collect all table ARNs dynamically
    const allTableArns: string[] = [];

    for (const school of tableNames) {
      const table = tables[school];
      allTableArns.push(table.tableArn); // main table
      allTableArns.push(`${table.tableArn}/index/*`); // GSI index
    }
    APIGatewayHandlerLambdaExecutionRole.attachInlinePolicy(
      new iam.Policy(this, `${project}APIGatewayHandlerInlinePolicy`, {
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
        ],
      }),
    );

    const ApiGwToSqsRole = new iam.Role(this, `${project}ApiGwV2ToSqsRole`, {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      roleName: `${project}ApiGwV2ToSqsRole`,
    });

    ApiGwToSqsRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, "ApiGwPushCwPolicy", "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"));

    ApiGwToSqsRole.attachInlinePolicy(
      new iam.Policy(this, `${project}ApiGwV2ToSqsInlinePolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:PurgeQueue", "sqs:DeleteMessage"],
            resources: [bufferingQueue.queueArn],
          }),
        ],
      }),
    );

    //Lambda - apigatewayhandlerFunction
    const ApiGatewayHandlerFunction = new lambda.Function(this, `${project}apigatewayhandler`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "apigatewayhandler.handler",
      functionName: `${project}apigatewayhandler`,
      role: APIGatewayHandlerLambdaExecutionRole,
      environment: {
        TABLE_NAME: tables[tableNames[0]].tableName,
        // add more if you onboard more schools
      },
    });

    const RecipeAILambdaExecutionRole = new iam.Role(this, `${project}RecipeAILambdaExecutionRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    RecipeAILambdaExecutionRole.attachInlinePolicy(
      new iam.Policy(this, `${project}RecipeAIPolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
            resources: allTableArns,
          }),
          new iam.PolicyStatement({
            actions: ["s3:PutObject", "s3:PutObjectAcl"],
            resources: [recipeBucket.bucketArn + "/*"],
          }),
          new iam.PolicyStatement({
            actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            resources: ["*"],
          }),
        ],
      }),
    );

    const RecipeAIGeminiFunction = new lambda.Function(this, `${project}RecipeAIGeminiFunction`, {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("lambda/recipe-ai-gemini"),
      handler: "index.handler",
      functionName: `${project}recipe-ai-gemini`,
      role: RecipeAILambdaExecutionRole,
      timeout: Duration.seconds(30), // Gemini models can take some time
      memorySize: 256,
      environment: {
        TABLE_NAME: tables[tableNames[0]].tableName,
        BUCKET_NAME: recipeBucket.bucketName,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "REPLACE_WITH_YOUR_KEY",
      },
    });


    const ApiGwToLambdaRole = new iam.Role(this, `${project}ApiGwToLambdaRole`, {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      roleName: `${project}ApiGwToLambdaRole`,
    });

    ApiGwToLambdaRole.attachInlinePolicy(
      new iam.Policy(this, `${project}ApiGwToLambdaInlinePolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction", "secretsmanager:GetSecretValue"],
            resources: [ApiGatewayHandlerFunction.functionArn],
          }),
          // Allow Lambda to send email via SES
          new iam.PolicyStatement({
            actions: ["ses:SendEmail", "ses:SendRawEmail"],
            resources: ["arn:aws:ses:us-east-1:287190273383:identity/info@ssndigitalmedia.com"], // * for all
          }),
        ],
      }),
    );

    ApiGwToLambdaRole.attachInlinePolicy(
      new iam.Policy(this, `${project}ApiGwToRecipeAILambdaInlinePolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [RecipeAIGeminiFunction.functionArn],
          }),
        ],
      })
    );

    ////..................api Gateway................/////////

    const api = new apigwv2.CfnApi(this, `${project}HttpToSqs-API`, {
      corsConfiguration: {
        allowCredentials: false,
        allowHeaders: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

    const httpApiIntegInvokeRecipeAILambda = new apigwv2.CfnIntegration(this, `${project}httpApiIntegInvokeRecipeAILambda`, {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      payloadFormatVersion: "1.0",
      credentialsArn: ApiGwToLambdaRole.roleArn, 
      integrationUri: RecipeAIGeminiFunction.functionArn,
    });

    const HttpApiRoute2 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg2`, {
      apiId: api.ref,
      routeKey: "GET /itemsbytype/{id}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute4 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg4`, {
      apiId: api.ref,
      routeKey: "GET /items/{id}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute5 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg5`, {
      apiId: api.ref,
      routeKey: "PUT /items",
      target: `integrations/${httpApiIntegSqsSendMessage.ref}`,
    });
    const HttpApiRoute6 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg6`, {
      apiId: api.ref,
      routeKey: "POST /items",
      target: `integrations/${httpApiIntegSqsSendMessage.ref}`,
    });
    const HttpApiRoute3 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg3`, {
      apiId: api.ref,
      routeKey: "DELETE /removeitem/{id}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute7 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute7`, {
      apiId: api.ref,
      routeKey: "POST /getsecrets",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute10 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute10`, {
      apiId: api.ref,
      routeKey: "POST /items/filter2column",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute11 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute11`, {
      apiId: api.ref,
      routeKey: "POST /sendemail",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRouteEmail = new apigwv2.CfnRoute(this, `${project}HttpApiRouteEmail`, {
      apiId: api.ref,
      routeKey: "GET /itemsbyemail/{email}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRouteRecipeAI = new apigwv2.CfnRoute(this, `${project}HttpApiRouteRecipeAI`, {
      apiId: api.ref,
      routeKey: "POST /recipe-ai-gemini",
      target: `integrations/${httpApiIntegInvokeRecipeAILambda.ref}`,
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
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/items/{id}`,
    });

    const HttpApiLambdaPermission2 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission2`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/itemsbytype/{id}`,
    });

    const HttpApiLambdaPermission4 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission4`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/getsecrets`,
    });

    const HttpApiLambdaPermission7 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission7`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/removeitem/{id}`,
    });
    const HttpApiLambdaPermission8 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission8`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/items/filter2column`,
    });
    const HttpApiLambdaPermission9 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission9`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/sendemail`,
    });

    const HttpApiLambdaPermissionEmail = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermissionEmail`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/itemsbyemail/{email}`,
    });

    ////..................Outputs................/////////
    const HttpApiRecipeAIPermission = new lambda.CfnPermission(this, `${project}HttpApiRecipeAIPermission`, {
      action: "lambda:InvokeFunction",
      functionName: RecipeAIGeminiFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/recipe-ai-gemini`,
    });

    ////..................Outputs................/////////
    new cdk.CfnOutput(this, `${project}HttpApiEndpoint`, {
      description: "API Endpoint",
      value: api.attrApiEndpoint,
    });
  }
}
