#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config();
import * as cdk from "aws-cdk-lib";
import { TempleAppInfraCdkStack } from "../lib/infra-cdk-stack";
import * as process from "process";

const app = new cdk.App();
new TempleAppInfraCdkStack(app, "TempleAppInfraCdkStack", {
  env: {
    //account: "949365052778", // bala account
    account: "287190273383", //authexitAroun account
    region: "ap-south-1",
    //region: "us-east-1",
  },
});
