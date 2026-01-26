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

export class AuthExitAppInfraCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    //var project = "FaceCheckInApp-";
    //var project = "SplitEqualApp-";
    var project = "AuthExit-";
    var projectadmin = "AuthExitAdmin-";
    //var project = "RecipeAIApp-";
    // var project = "TalesOfSuba-";
    // var project = "KnowUrCircle-";
    // var project = "SSNDigitalMedia-";

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
    const table = new dynamodb.Table(this, `${project}event-table`, {
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: `${project}EventTable`,
    });
    //admintable
    const admintable = new dynamodb.Table(this, `${projectadmin}event-table`, {
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: `${projectadmin}EventTable`,
    });

    ////..................Roles................/////////

    const APIGatewayHandlerLambdaExecutionRole = new iam.Role(this, `${project}APIGatewayHandlerLambdaExecutionRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: `${project}APIGatewayHandlerLambdaExecutionRole`,
    });

    APIGatewayHandlerLambdaExecutionRole.attachInlinePolicy(
      new iam.Policy(this, `${project}APIGatewayHandlerInlinePolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ["dynamodb:List*", "dynamodb:DescribeReservedCapacity*", "dynamodb:DescribeLimits", "dynamodb:DescribeTimeToLive", "dynamodb:Get*", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"],
            resources: [table.tableArn],
          }),
          // new table admintable
          new iam.PolicyStatement({
            actions: ["dynamodb:List*", "dynamodb:DescribeReservedCapacity*", "dynamodb:DescribeLimits", "dynamodb:DescribeTimeToLive", "dynamodb:Get*", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"],
            resources: [admintable.tableArn],
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
        table: table.tableName,
        admintable: admintable.tableName, // delete admintable
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
            resources: ["arn:aws:ses:us-east-1:287190273383:identity/support@authexit.org"], // * for all
          }),
        ],
      }),
    );

    ////..................api Gateway................/////////

    const api = new apigwv2.CfnApi(this, `${project}HttpToSqs-API`, {
      corsConfiguration: {
        allowCredentials: false,
        allowHeaders: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE"],
        allowOrigins: ["*"],
        maxAge: 43200,
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
    const HttpApiRoute1 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg1`, {
      apiId: api.ref,
      routeKey: "POST /itemupdate",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute7 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute7`, {
      apiId: api.ref,
      routeKey: "POST /getsecrets",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute8 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg8`, {
      apiId: api.ref,
      routeKey: "GET /userid/{id}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute9 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg9`, {
      apiId: api.ref,
      routeKey: "GET /items/{column}/{value}",
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

    const HttpApiLambdaPermission3 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission3`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/itemupdate`,
    });

    const HttpApiLambdaPermission4 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission4`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/getsecrets`,
    });
    const HttpApiLambdaPermission5 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission5`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/userid/{id}`,
    });
    const HttpApiLambdaPermission6 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission6`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/items/{column}/{value}`,
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

    ////..................Outputs................/////////
    new cdk.CfnOutput(this, `${project}HttpApiEndpoint`, {
      description: "API Endpoint",
      value: api.attrApiEndpoint,
    });
  }
}
