import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import webhookToDynamo from "./webhookToDynamo";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import triggerCircleCIWorkflows from "./triggerCircleCIWorkflows";
import pytorchBot from "./pytorchBot";
import drciBot from "./drciBot";

export default function bot(app: Probot) {
  autoCcBot(app);
  autoLabelBot(app);
  verifyDisableTestIssueBot(app);
  ciflowPushTrigger(app);
  webhookToDynamo(app);
  triggerCircleCIWorkflows(app);
  pytorchBot(app);
  drciBot(app);
}
