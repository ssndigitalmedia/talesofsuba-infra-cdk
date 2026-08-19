import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";
import * as corsConfig from "../cors.config.json";
import * as envConfig from "../env.config.json";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cdk from "aws-cdk-lib/core";

export class TempleAppInfraCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    var project = "temple-";
    var tableNames: string[] = [];
    // Allowed origins live in cors.config.json so a new temple domain is a
    // one-line data edit, not a code change. EVERY array in that file is
    // merged, so new groups can be added there without touching this file
    // (`_readme` is a string[] too, hence the http(s) filter). Consumed by
    // API Gateway CORS, the S3 CORS rule and the S3 referer policy below.
    const corsOrigins: string[] = Array.from(
      new Set(
        Object.entries(corsConfig as Record<string, unknown>)
          .filter(([key]) => key !== "_readme")
          .flatMap(([, value]) => (Array.isArray(value) ? (value as string[]) : []))
          .map((origin) => String(origin).trim().replace(/\/+$/, "")) // a trailing slash never matches
          .filter((origin) => /^https?:\/\//.test(origin))
      )
    );
    if (corsOrigins.length === 0) {
      throw new Error("cors.config.json produced no origins — refusing to deploy a stack that would reject every browser request.");
    }
    // Per-environment settings (table list, bucket, replica region) live in
    // env.config.json, keyed by region — adding a temple is a data edit there.
    type EnvEntry = {
      label: string;
      project: string;
      s3Bucket: string;
      replicaRegion: string;
      /** Create Global Table replicas in replicaRegion. false removes them. */
      replicate?: boolean;
      /** Region the Lambda uses for DynamoDB. null = its own region (normal). */
      activeDbRegion?: string | null;
      tableNames: string[];
    };
    const envEntry = (envConfig as unknown as Record<string, EnvEntry>)[this.region];
    if (!envEntry) {
      // Previously an unknown region silently `return`ed, producing an empty
      // stack that looked like a successful deploy. Fail loudly instead.
      throw new Error(
        `No entry for region "${this.region}" in env.config.json — add one (or deploy to ${Object.keys(envConfig).filter((k) => k !== "_readme").join(" / ")}).`
      );
    }
    /**
     * Which region the API Lambda talks to DynamoDB in.
     *
     * env.config.json holds the durable answer, so the committed file always
     * shows where traffic is actually meant to go. DDB_REGION in the deploy
     * shell overrides it, which is what scripts/ddb-failover.sh flips during an
     * incident; empty means "use whatever region the Lambda itself runs in".
     */
    const activeDbRegion = String(process.env.DDB_REGION ?? envEntry.activeDbRegion ?? "").trim();
    if (activeDbRegion && activeDbRegion !== this.region && activeDbRegion !== envEntry.replicaRegion) {
      // A typo here would point every read and write at a table that does not
      // exist, so it is refused at synth rather than discovered at runtime.
      throw new Error(
        `activeDbRegion "${activeDbRegion}" is neither this region (${this.region}) nor its replica (${envEntry.replicaRegion}).`
      );
    }
    if (activeDbRegion && activeDbRegion !== this.region) {
      console.warn("\x1b[33m%s\x1b[0m", `NOTE: DynamoDB traffic is pinned to ${activeDbRegion}, not ${this.region}.`);
    }

    var s3BucketName = envEntry.s3Bucket;
    project = envEntry.project;
    tableNames = envEntry.tableNames;
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
    //
    // ── Multi-region (DynamoDB Global Tables) ─────────────────────────────
    // The replica lives in a DIFFERENT region per environment so QA and PROD
    // never replicate into each other:
    //     QA   ap-south-1 (Mumbai)   ->  ap-southeast-1 (Singapore)  ~55ms
    //     PROD us-east-1  (Virginia) ->  us-west-2      (Oregon)     ~65ms
    //
    // WHY `dynamodb.Table` + `replicationRegions` and NOT `TableV2`:
    // TableV2 is a different CloudFormation resource type
    // (AWS::DynamoDB::GlobalTable vs AWS::DynamoDB::Table). Switching these
    // EXISTING tables to it would make CloudFormation delete and recreate
    // them — data loss. `replicationRegions` adds the replica in place via an
    // UpdateTable call, with no replacement and no downtime.
    //
    // Streams are a hard prerequisite for replication, and adding one is also
    // an in-place update.
    //
    // NOTE: Global Tables is replication, NOT backup — it copies deletes and
    // corruption to every replica instantly. `pointInTimeRecovery` below is
    // the actual protection against bad data, which is why it is on even
    // where replication is off.
    const isProd = process.env.ENV === "PROD";
    const replicaRegion = envEntry.replicaRegion;
    // Replication is declared per region in env.config.json, so the flag lives
    // in the same block as the region it arms. That is what keeps QA and PROD
    // independent: `ENV` is flipped in .env.local, and a single shared flag left
    // at "true" after QA testing would have armed PROD the moment ENV changed.
    // Keyed by region, that cannot happen — and the committed file now shows
    // which environments replicate, which a gitignored .env.local never did.
    //
    // REPLICATE_QA / REPLICATE_PROD still override, for a one-off deploy
    // without editing the file.
    const replicationOverride = isProd ? process.env.REPLICATE_PROD : process.env.REPLICATE_QA;
    const hasOverride = replicationOverride !== undefined && String(replicationOverride).trim() !== "";
    const enableReplication = hasOverride
      ? String(replicationOverride).trim().toLowerCase() === "true"
      : envEntry.replicate === true;
    if (hasOverride) {
      console.warn("\x1b[33m%s\x1b[0m", `NOTE: env.config.json replicate=${envEntry.replicate === true} overridden to ${enableReplication}.`);
    }
    // QA and PROD deploy the SAME table names into different regions. That is
    // fine for standalone tables, but a Global Table name is claimed across ALL
    // regions at once, so `TempleAdmin-EventTable` cannot be a global table in
    // both environments. Without this check the clash only surfaces mid-deploy,
    // as "Global table with name ... already exists with replicas in regions",
    // after the stack has already started rolling forward.
    if (enableReplication) {
      const clash = Object.entries(envConfig as unknown as Record<string, EnvEntry>)
        .filter(([region, entry]) => region !== "_readme" && region !== this.region && entry?.replicate === true)
        .map(([region, entry]) => ({ region, shared: (entry.tableNames || []).filter((t) => tableNames.includes(t)) }))
        .filter((c) => c.shared.length > 0);
      if (clash.length > 0) {
        const { region: other, shared } = clash[0];
        throw new Error(
          `Cannot replicate from ${this.region}: ${other} already has replicate: true and shares table name(s) ${shared.join(", ")}. ` +
          `A Global Table name is global, so only one environment can replicate a given table at a time. ` +
          `Set replicate: false for ${other} and deploy that region first, or give the environments distinct table names.`
        );
      }
    }

    if (activeDbRegion === replicaRegion && !enableReplication) {
      // Pointing the Lambda at a replica while replication is off would delete
      // that replica and send every read and write to a table that no longer
      // exists. The two settings are only coherent together.
      throw new Error(
        `activeDbRegion is "${replicaRegion}" but replicate is false — that would remove the very table the Lambda is being pointed at. Set replicate: true, or clear activeDbRegion.`
      );
    }
    if (!enableReplication) {
      // Replicas are removed, not just left alone, when this goes false — worth
      // saying out loud, because the deploy log looks routine either way.
      console.warn("\x1b[33m%s\x1b[0m", `NOTE: replication OFF for ${this.region}. Any existing replica in ${replicaRegion} will be REMOVED.`);
    }
    // Never list the region we are deploying INTO — DynamoDB rejects that.
    const replicationRegions =
      enableReplication && replicaRegion !== this.region ? [replicaRegion] : undefined;

    /** Shared resilience settings for every table in this stack. */
    const tableResilience = {
      // Restore any point in the last 35 days; independent of replication.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // A `cdk destroy` must never take the data with it.
      removalPolicy: RemovalPolicy.RETAIN,
      // Required by Global Tables; harmless when replication is off.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      ...(replicationRegions ? { replicationRegions } : {}),
    };

    const tables: { [key: string]: dynamodb.Table } = {};
    // Replica creation is a DynamoDB CONTROL-PLANE operation and only a couple
    // may run at once per account/region — creating all six together fails with
    // "TooManyRequestsException: Rate Exceeded".
    //
    // So the replicas are chained to run ONE AT A TIME. Critically the chain is
    // between the replica resources ONLY, not whole table constructs: CDK also
    // attaches a per-table IAM policy granting the replica provider
    // DescribeTable, and making those wait behind the previous replica left no
    // time for IAM to propagate — the provider then failed with "not authorized
    // to perform: dynamodb:DescribeTable". Policies are cheap and unthrottled,
    // so they are all created up front, in parallel, while only the replicas
    // queue.
    const replicaNodes: Construct[] = [];
    /** The Replica<region> child CDK adds to a table when replicationRegions is set. */
    const replicaOf = (t: dynamodb.Table): Construct | undefined =>
      t.node.tryFindChild(`Replica${replicaRegion}`) as Construct | undefined;
    for (const tbl of tableNames) {
      const table = new dynamodb.Table(this, `${tbl}event-table`, {
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        tableName: `${tbl}EventTable`,
        ...tableResilience,
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
        indexName: "type-date-index",
        partitionKey: {
          name: "type",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "date",
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      // Per-devotee order lookup (Canteen Spend Phase 4 / CANTEEN_SPEND_LAMBDA_SPEC §4).
      // Sparse by design — only order items carry `devoteeId` (guests/walk-ins omit it),
      // so this index contains only attributed orders. Lets a profile view read ONE
      // devotee's orders directly instead of scanning all orders via type-index.
      table.addGlobalSecondaryIndex({
        indexName: "order-devotee-index",
        partitionKey: {
          name: "devoteeId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "createdate",
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      const replica = replicationRegions ? replicaOf(table) : undefined;
      if (replica) {
        const previous = replicaNodes[replicaNodes.length - 1];
        if (previous) replica.node.addDependency(previous);
        replicaNodes.push(replica);
      }
      tables[tbl] = table;
    }

    ////..................Audit Logs Table................/////////
    // Dedicated table for audit-log entries: PK orgCode, SK timestamp (ISO-8601),
    // on-demand billing, with TTL on the numeric `ttl` (epoch seconds) attribute.
    const auditLogsTable = new dynamodb.Table(this, `${project}audit-logs-table`, {
      partitionKey: {
        name: "orgCode",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      tableName: `${project}audit-logs`,
      ...tableResilience,
    });
    // Same reason as above — the last replica must not start until the 5th is done.
    const auditReplica = replicationRegions ? replicaOf(auditLogsTable) : undefined;
    if (auditReplica && replicaNodes.length > 0) {
      auditReplica.node.addDependency(replicaNodes[replicaNodes.length - 1]);
    }

    ////..................S3 Bucket for Book Covers (Imported)................/////////
    const templeBucketName = s3.Bucket.fromBucketName(this, `${project}TempleBucket`, s3BucketName);

    ////..................Secure Documents Bucket (private)................/////////
    // Private bucket for sensitive uploads (checks, payment/PayPal screenshots, etc.).
    // Fully blocked from public access — objects are served ONLY via short-lived
    // presigned URLs generated by the Lambda after JWT verification.
    const secureDocsBucket = new s3.Bucket(this, `${project}secure-docs-bucket`, {
      bucketName: `${project}secure-docs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // Allow the browser to PUT (presigned upload for large files, e.g. newsletters)
      // and GET (presigned view) directly against the bucket from our web origins.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: corsOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    });

    ////..................Roles................/////////

    const APIGatewayHandlerLambdaExecutionRole = new iam.Role(this, `${project}APIGatewayHandlerLambdaExecutionRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: `${project}APIGatewayHandlerLambdaExecutionRole`,
    });
    // collect all table ARNs dynamically
    const allTableArns: string[] = [];

    /** The same table, addressed in the replica region. */
    const replicaArn = (tableName: string, suffix = "") =>
      cdk.Arn.format(
        { service: "dynamodb", region: replicaRegion, resource: "table", resourceName: `${tableName}${suffix}` },
        this,
      );

    /**
     * Grant a table in BOTH regions, unconditionally — even when replication is
     * switched off. An ARN for a table that does not exist yet is inert, and
     * having the permission already in place means a manual failover is an
     * env-var flip rather than an IAM deploy in the middle of an outage.
     *
     * `table.tableArn` is a CloudFormation token, not a literal string, so the
     * replica ARN has to be built structurally. Replacing the region substring
     * inside a token silently yields the primary ARN back.
     */
    const grantBothRegions = (table: dynamodb.ITable, withIndexes: boolean) => {
      allTableArns.push(table.tableArn);
      if (withIndexes) allTableArns.push(`${table.tableArn}/index/*`);
      if (replicaRegion && replicaRegion !== this.region) {
        allTableArns.push(replicaArn(table.tableName));
        if (withIndexes) allTableArns.push(replicaArn(table.tableName, "/index/*"));
      }
    };

    for (const tbl of tableNames) {
      grantBothRegions(tables[tbl], true); // table + its GSIs
    }
    // grant the Lambda read/write on the audit-logs table
    grantBothRegions(auditLogsTable, false); // no GSIs on the audit table
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
          new iam.PolicyStatement({
            actions: ["sns:Publish", "sns:CreatePlatformEndpoint", "sns:SetEndpointAttributes", "sns:DeleteEndpoint"],
            resources: ["*", "arn:aws:sns:us-east-1:287190273383:app/APNS/Temple_Apple_PushNotification", "arn:aws:sns:us-east-1:287190273383:app/GCM/Temple_Android_PushNotification", "arn:aws:sns:us-east-1:287190273383:endpoint/APNS/Temple_Apple_PushNotification/*", "arn:aws:sns:us-east-1:287190273383:endpoint/GCM/Temple_Android_PushNotification/*"],
          }),
          new iam.PolicyStatement({
            actions: ["s3:PutObject", "s3:DeleteObject"],
            resources: [templeBucketName.arnForObjects("*")],
          }),
          // Private secure-docs bucket: read + write (GetObject needed for presigning)
          new iam.PolicyStatement({
            actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
            resources: [secureDocsBucket.arnForObjects("*")],
          }),
          // Textract for OCR extraction (no resource-level permissions supported)
          new iam.PolicyStatement({
            actions: ["textract:AnalyzeDocument", "textract:DetectDocumentText"],
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

    // JWT signing secret, chosen by region (prod vs QA). Shared by the handler and the authorizer.
    const jwtSecret = (() => {
      const region = `${cdk.Stack.of(this).region}`;
      const secret = region === "us-east-1" ? process.env.JWT_SECRET_PROD : process.env.JWT_SECRET_QA;
      if (!secret) {
        console.warn("\x1b[33m%s\x1b[0m", "WARNING: JWT_SECRET environment variable is not set. Using default secret - THIS IS INSECURE!");
      }
      return secret || "your-default-secret";
    })();

    //Lambda - apigatewayhandlerFunction
    const ApiGatewayHandlerFunction = new lambda.Function(this, `${project}apigatewayhandler`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "apigatewayhandler.handler",
      functionName: `${project}apigatewayhandler`,
      role: APIGatewayHandlerLambdaExecutionRole,
      timeout: Duration.seconds(60),
      environment: {
        ADMIN_TABLE: tables["TempleAdmin-"].tableName,
        // Manual regional failover, from env.config.json's activeDbRegion.
        // Empty (the default) means the handler talks to DynamoDB in its own
        // region. See scripts/ddb-failover.sh for the break-glass path.
        DDB_REGION: activeDbRegion,
        AUDIT_LOG_TABLE: auditLogsTable.tableName,
        SECURE_DOCS_BUCKET: secureDocsBucket.bucketName,
        PLATFORM_ARN_IOS: "arn:aws:sns:us-east-1:287190273383:app/APNS/TempleHub_Apple_PushNotification",
        PLATFORM_ARN_ANDROID: "arn:aws:sns:us-east-1:287190273383:app/GCM/TempleHub_Android_PushNotification",
        BUCKET_NAME: templeBucketName.bucketName,
        S3_REGION: `${cdk.Stack.of(this).region}`,
        BUCKET_URL: `https://${templeBucketName.bucketName}.s3.${cdk.Stack.of(this).region}.amazonaws.com`,
        JWT_SECRET: jwtSecret,
        GEMINI_API_KEY: (() => {
          const key = process.env.GEMINI_API_KEY;
          if (!key) {
            console.warn("\x1b[33m%s\x1b[0m", "WARNING: GEMINI_API_KEY environment variable is not set. AI routes will fail until it is provided.");
          }
          return key || "";
        })(),
        GEMINI_IMAGE_MODEL: (() => {
          const model = process.env.GEMINI_IMAGE_MODEL;
          if (!model) {
            console.warn("\x1b[33m%s\x1b[0m", "WARNING: GEMINI_IMAGE_MODEL environment variable is not set. AI image routes will fail until it is provided.");
          }
          return model || "";
        })(),
        // add more if you onboard more org
      },
    });

    // S3 Bucket Policy for the imported bucket
    new s3.CfnBucketPolicy(this, `${project}TempleBucketPolicy`, {
      bucket: templeBucketName.bucketName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowLambdaS3Management",
            Effect: "Allow",
            Principal: {
              AWS: APIGatewayHandlerLambdaExecutionRole.roleArn,
            },
            Action: ["s3:PutObject", "s3:DeleteObject"],
            Resource: templeBucketName.arnForObjects("*"),
          },
          {
            Sid: "DenyNonLambdaS3Management",
            Effect: "Deny",
            Principal: "*",
            Action: ["s3:PutObject", "s3:DeleteObject"],
            Resource: templeBucketName.arnForObjects("*"),
            Condition: {
              StringNotEquals: {
                "aws:PrincipalArn": APIGatewayHandlerLambdaExecutionRole.roleArn,
              },
            },
          },
          {
            Sid: "AllowPublicReadFromWebsite",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: templeBucketName.arnForObjects("*"),
            Condition: {
              StringLike: {
                "aws:Referer": corsOrigins.map((o) => `${o}/*`),
              },
            },
          },
        ],
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

    ////..................JWT Authorizer................/////////
    // Reuses the existing handler Lambda (it branches on event.type === "REQUEST").
    // API Gateway assumes ApiGwToLambdaRole to invoke it (that role already has
    // lambda:InvokeFunction on this function), so no extra CfnPermission is needed.
    const jwtAuthorizer = new apigwv2.CfnAuthorizer(this, `${project}JwtAuthorizer`, {
      apiId: api.ref,
      authorizerType: "REQUEST",
      name: `${project}JwtAuthorizer`,
      authorizerPayloadFormatVersion: "2.0",
      enableSimpleResponses: true,
      identitySource: ["$request.header.Authorization"],
      authorizerUri: `arn:aws:apigateway:${cdk.Stack.of(this).region}:lambda:path/2015-03-31/functions/${ApiGatewayHandlerFunction.functionArn}/invocations`,
      authorizerCredentialsArn: ApiGwToLambdaRole.roleArn,
      authorizerResultTtlInSeconds: 0, // no caching while validating; raise later (e.g. 300) for perf
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
      authorizationType: "CUSTOM",
      authorizerId: jwtAuthorizer.ref,
    });
    const HttpApiRoute6 = new apigwv2.CfnRoute(this, `${project}HttpApiRouteSqsSendMsg6`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/items",
      target: `integrations/${httpApiIntegSqsSendMessage.ref}`,
      authorizationType: "CUSTOM",
      authorizerId: jwtAuthorizer.ref,
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

    const HttpApiRoute13 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute13`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/registerdevice",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });
    const HttpApiRoute14 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute14`, {
      apiId: api.ref,
      routeKey: "GET /{orgCode}/itemsbytypeanddate/{id}/{date}",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute15 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute15`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/saveitem",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute16 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute16`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/sendpushUser",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute17 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute17`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/create-ai-image-using-gemini",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute18 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute18`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/create-ai-description-using-gemini",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute19 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute19`, {
      apiId: api.ref,
      routeKey: "GET /{orgCode}/audit-logs",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute20 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute20`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/ocrtextextract",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    const HttpApiRoute21 = new apigwv2.CfnRoute(this, `${project}HttpApiRoute21`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/get-presigned-url",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    // Presigned PUT for large direct-to-S3 uploads (newsletters, etc.) — see the
    // get-upload-url case in apigatewayhandler.js. Bypasses the API Gateway/Lambda
    // ~6MB payload limit; only the returned S3 key is persisted on the item.
    const HttpApiRouteGetUploadUrl = new apigwv2.CfnRoute(this, `${project}HttpApiRouteGetUploadUrl`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/get-upload-url",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    // Per-devotee order lookup via order-devotee-index (Canteen Spend Phase 4).
    // Paginated (limit/nextToken) per API_PAGINATION_SPEC.md.
    const HttpApiRouteOrdersByDevotee = new apigwv2.CfnRoute(this, `${project}HttpApiRouteOrdersByDevotee`, {
      apiId: api.ref,
      routeKey: "POST /{orgCode}/orders-by-devotee",
      target: `integrations/${httpApiIntegInvokeLambda.ref}`,
    });

    // Reference the existing CloudWatch Logs log group that AWS Lambda
    // auto-creates for the function (avoids "AlreadyExists" on deploy).
    const lambdaLogGroup = logs.LogGroup.fromLogGroupName(this, "MyLambdaLogGroup", "/aws/lambda/" + ApiGatewayHandlerFunction.functionName);

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

    const HttpApiLambdaPermission11 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission11`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/registerdevice`,
    });
    const HttpApiLambdaPermission12 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission12`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/itemsbytypeanddate/{id}/{date}`,
    });
    const HttpApiLambdaPermission13 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission13`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/saveitem`,
    });

    const HttpApiLambdaPermission14 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission14`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/sendpushUser`,
    });

    const HttpApiLambdaPermission15 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission15`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/create-ai-image-using-gemini`,
    });

    const HttpApiLambdaPermission16 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission16`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/create-ai-description-using-gemini`,
    });

    const HttpApiLambdaPermission17 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission17`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/audit-logs`,
    });

    const HttpApiLambdaPermission18 = new lambda.CfnPermission(this, `${project}HttpApiLambdaPermission18`, {
      action: "lambda:InvokeFunction",
      functionName: ApiGatewayHandlerFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${api.ref}/*/*/{orgCode}/ocrtextextract`,
    });

    ////..................Outputs................/////////
    new cdk.CfnOutput(this, `${project}HttpApiEndpoint`, {
      description: "API Endpoint",
      value: api.attrApiEndpoint,
    });
  }
}
