#!/usr/bin/env node
import * as dotenv from "dotenv";
import * as path from "path";
// Load .env.local first (developer overrides), then fall back to .env
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import * as cdk from "aws-cdk-lib";
import { TempleAppInfraCdkStack } from "../lib/infra-cdk-stack";
import * as process from "process";

const app = new cdk.App();
// QA -> ap-south-1, PROD -> us-east-1
const region = process.env.ENV === "PROD" ? "us-east-1" : "ap-south-1";
new TempleAppInfraCdkStack(app, "TempleAppInfraCdkStack", {
  env: {
    //account: "949365052778", // bala account
    account: "287190273383", //authexitAroun account
    region,
  },
});
