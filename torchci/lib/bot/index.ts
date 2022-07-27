import { Probot } from "probot";
import acceptBot from "./acceptBot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import drciBot from "./drciBot";
import pytorchBot from "./pytorchBot";
import triggerCircleCIWorkflows from "./triggerCircleCIWorkflows";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import webhookToDynamo from "./webhookToDynamo";

export default function bot(app: Probot) {
  autoCcBot(app);
  autoLabelBot(app);
  verifyDisableTestIssueBot(app);
  ciflowPushTrigger(app);
  webhookToDynamo(app);
  triggerCircleCIWorkflows(app);
  pytorchBot(app);
  drciBot(app);
  acceptBot(app);
}
