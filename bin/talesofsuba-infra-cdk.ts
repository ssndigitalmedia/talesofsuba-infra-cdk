#!/usr/bin/env node
import * as dotenv from "dotenv";
import * as path from "path";
// Load the AuthExit-specific env file first (developer overrides), then fall back to .env
dotenv.config({ path: path.resolve(__dirname, "../.env.local.authexit") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import * as cdk from "aws-cdk-lib";
import { AuthExitAppInfraCdkStack, EnvConfig } from "../lib/infra-cdk-stack";

// Non-secret, per-environment config (region, account, corsOrigins, schoolNames, ...).
// Secrets stay in the env file (.env.local.authexit); only config lives here.
const environments: { [key: string]: EnvConfig } = require("../config/environments.authexit.json");

const app = new cdk.App();

// Select the environment via CDK context: `cdk deploy -c env=prod` (defaults to qa).
const envName = (app.node.tryGetContext("env") || "qa").toLowerCase();
const config = environments[envName];
if (!config) {
  throw new Error(`Unknown env "${envName}". Use -c env=qa or -c env=prod.`);
}

new AuthExitAppInfraCdkStack(app, "AuthExitAppInfraCdkStack", {
  config,
  env: {
    account: config.account,
    region: config.region,
  },
});
