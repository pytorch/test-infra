import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import autorunSafeWorkflowsBot from "./autorunSafeWorkflowsBot";
import cancelWorkflowsOnCloseBot from "./cancelWorkflowsOnCloseBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import codevNoWritePerm from "./codevNoWritePermBot";
import drciBot from "./drciBot";
import isTheBotStateful from "./statefulBot";
import pytorchBot from "./pytorchBot";
import retryBot from "./retryBot";
import stripApprovalBot from "./stripApprovalBot";
import triggerCircleCIWorkflows from "./triggerCircleCIWorkflows";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import webhookToDynamo from "./webhookToDynamo";

export default function bot(app: Probot) {
  autoCcBot(app);
  autorunSafeWorkflowsBot(app);
  cancelWorkflowsOnCloseBot(app);
  ciflowPushTrigger(app);
  codevNoWritePerm(app);
  drciBot(app);
  isTheBotStateful(app);
  pytorchBot(app);
  retryBot(app);
  stripApprovalBot(app);
  triggerCircleCIWorkflows(app);
  verifyDisableTestIssueBot(app);
  webhookToDynamo(app);
}
