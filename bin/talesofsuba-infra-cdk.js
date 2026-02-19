#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
//import { TalesofsubaInfraCdkStack } from "../lib/infra-cdk-stack";
//import { KnowUrCircleInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SSNDigitalMediaInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SSNMobileAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { RecipeAIeAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { FaceCheckInAppInfraCdkStack } from "../lib/infra-cdk-stack";
//import { SplitEqualAppInfraCdkStack } from "../lib/infra-cdk-stack";
const infra_cdk_stack_1 = require("../lib/infra-cdk-stack");
const app = new cdk.App();
new infra_cdk_stack_1.AuthExitAppInfraCdkStack(app, "AuthExitAppInfraCdkStack", {
    env: {
        //account: "949365052778",
        account: "287190273383", //authexitAroun account
        region: "ap-south-1",
        //region: "us-east-1",
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGFsZXNvZnN1YmEtaW5mcmEtY2RrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGFsZXNvZnN1YmEtaW5mcmEtY2RrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUNBLG1DQUFtQztBQUNuQyxvRUFBb0U7QUFDcEUscUVBQXFFO0FBQ3JFLHdFQUF3RTtBQUN4RSxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLHVFQUF1RTtBQUN2RSxzRUFBc0U7QUFDdEUsNERBQWtFO0FBR2xFLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQzFCLElBQUksMENBQXdCLENBQUMsR0FBRyxFQUFFLDBCQUEwQixFQUFFO0lBQzVELEdBQUcsRUFBRTtRQUNILDBCQUEwQjtRQUMxQixPQUFPLEVBQUUsY0FBYyxFQUFFLHVCQUF1QjtRQUNoRCxNQUFNLEVBQUUsWUFBWTtRQUNwQixzQkFBc0I7S0FDdkI7Q0FDRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG4vL2ltcG9ydCB7IFRhbGVzb2ZzdWJhSW5mcmFDZGtTdGFjayB9IGZyb20gXCIuLi9saWIvaW5mcmEtY2RrLXN0YWNrXCI7XG4vL2ltcG9ydCB7IEtub3dVckNpcmNsZUluZnJhQ2RrU3RhY2sgfSBmcm9tIFwiLi4vbGliL2luZnJhLWNkay1zdGFja1wiO1xuLy9pbXBvcnQgeyBTU05EaWdpdGFsTWVkaWFJbmZyYUNka1N0YWNrIH0gZnJvbSBcIi4uL2xpYi9pbmZyYS1jZGstc3RhY2tcIjtcbi8vaW1wb3J0IHsgU1NOTW9iaWxlQXBwSW5mcmFDZGtTdGFjayB9IGZyb20gXCIuLi9saWIvaW5mcmEtY2RrLXN0YWNrXCI7XG4vL2ltcG9ydCB7IFJlY2lwZUFJZUFwcEluZnJhQ2RrU3RhY2sgfSBmcm9tIFwiLi4vbGliL2luZnJhLWNkay1zdGFja1wiO1xuLy9pbXBvcnQgeyBGYWNlQ2hlY2tJbkFwcEluZnJhQ2RrU3RhY2sgfSBmcm9tIFwiLi4vbGliL2luZnJhLWNkay1zdGFja1wiO1xuLy9pbXBvcnQgeyBTcGxpdEVxdWFsQXBwSW5mcmFDZGtTdGFjayB9IGZyb20gXCIuLi9saWIvaW5mcmEtY2RrLXN0YWNrXCI7XG5pbXBvcnQgeyBBdXRoRXhpdEFwcEluZnJhQ2RrU3RhY2sgfSBmcm9tIFwiLi4vbGliL2luZnJhLWNkay1zdGFja1wiO1xuaW1wb3J0ICogYXMgcHJvY2VzcyBmcm9tIFwicHJvY2Vzc1wiO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xubmV3IEF1dGhFeGl0QXBwSW5mcmFDZGtTdGFjayhhcHAsIFwiQXV0aEV4aXRBcHBJbmZyYUNka1N0YWNrXCIsIHtcbiAgZW52OiB7XG4gICAgLy9hY2NvdW50OiBcIjk0OTM2NTA1Mjc3OFwiLFxuICAgIGFjY291bnQ6IFwiMjg3MTkwMjczMzgzXCIsIC8vYXV0aGV4aXRBcm91biBhY2NvdW50XG4gICAgcmVnaW9uOiBcImFwLXNvdXRoLTFcIixcbiAgICAvL3JlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgfSxcbn0pO1xuIl19