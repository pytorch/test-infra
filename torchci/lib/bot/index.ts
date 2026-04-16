import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import autoLabelCodevTrunk from "./autoLabelCodevTrunk";
import cancelWorkflowsOnCloseBot from "./cancelWorkflowsOnCloseBot";
import checkLabelsBot from "./checkLabelsBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import codevNoWritePerm from "./codevNoWritePermBot";
import drciBot from "./drciBot";
import pytorchBot from "./pytorchBot";
import retryBot from "./retryBot";
import stripApprovalBot from "./stripApprovalBot";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import webhookToDynamo from "./webhookToDynamo";

export default function bot(app: Probot) {
  autoCcBot(app);
  autoLabelCodevTrunk(app);
  autoLabelBot(app);
  cancelWorkflowsOnCloseBot(app);
  checkLabelsBot(app);
  ciflowPushTrigger(app);
  codevNoWritePerm(app);
  drciBot(app);
  pytorchBot(app);
  retryBot(app);
  stripApprovalBot(app);
  verifyDisableTestIssueBot(app);
  webhookToDynamo(app);
}
