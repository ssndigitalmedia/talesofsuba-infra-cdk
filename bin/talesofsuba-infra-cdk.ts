#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
//import { TalesofsubaInfraCdkStack } from "../lib/infra-cdk-stack";
//import { KnowUrCircleInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SSNDigitalMediaInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SSNMobileAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { RecipeAIeAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { FaceCheckInAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SplitEqualAppInfraCdkStack } from "../lib/infra-cdk-stack";
import { DigitalPassAppInfraCdkStack } from "../lib/infra-cdk-stack";
import * as process from "process";

const app = new cdk.App();
new DigitalPassAppInfraCdkStack(app, "DigitalPassAppInfraCdkStack", {
  env: {
    account: "949365052778", // BALA ACOUNT
    //account: "287190273383", //authexitAroun account
    //region: "ap-south-1",
    region: "us-east-1",
  },
});
