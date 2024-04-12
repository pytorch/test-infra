import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import drciBot from "./drciBot";
import pytorchBot from "./pytorchBot";
import retryBot from "./retryBot";
import triggerCircleCIWorkflows from "./triggerCircleCIWorkflows";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import webhookToDynamo from "./webhookToDynamo";
import cancelWorkflowsOnCloseBot from "./cancelWorkflowsOnCloseBot";
import stripApprovalBot from "./stripApprovalBot";
import codevNoWritePerm from "./codevNoWritePermBot";
import isTheBotStateful from "./statefulBot";

export default function bot(app: Probot) {
  autoCcBot(app);
  stripApprovalBot(app);
  autoLabelBot(app);
  verifyDisableTestIssueBot(app);
  ciflowPushTrigger(app);
  webhookToDynamo(app);
  triggerCircleCIWorkflows(app);
  pytorchBot(app);
  drciBot(app);
  retryBot(app);
  cancelWorkflowsOnCloseBot(app);
  codevNoWritePerm(app);
  isTheBotStateful(app);
}
