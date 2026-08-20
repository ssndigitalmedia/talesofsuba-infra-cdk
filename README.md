# Blogging Website - Infrastructure Setup using AWS CDK

### Developing and automating the infrastructure of my website talesofsuba and working on creating a Restful service using API Gateway to send blogging content in JSON format to Queuing service that helps in the scalability of my application which furthers then hits lambda to process the valid data and then stores it back to the DynamoDB.

### US-EAST-1 Stack is for Prod while AP-SOUTH-1 is the QA environment

## Deploying (AuthExit)

The environment (qa/prod) is selected with a CDK context flag. Non-secret config
(region, account, corsOrigins, schoolNames, ...) lives in
`config/environments.authexit.json`; only secrets go in `.env.local.authexit`.

```bash
# Deploy QA (ap-south-1) — the default when no -c env is passed
cdk deploy -c env=qa
cdk deploy                 # same as above (defaults to qa)

# Deploy Prod (us-east-1)
cdk deploy -c env=prod
```

Use the same flag for the other CDK commands, e.g. `cdk diff -c env=prod` or
`cdk synth -c env=prod`.