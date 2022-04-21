import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import ciflowBot from "./ciflowBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import webhookToDynamo from "./webhookToDynamo";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import triggerCircleCIWorkflows from "./triggerCircleCIWorkflows";
import mergeBot from "./mergeBot";
import labelBot from "./labelBot";
import greenBot from "./greenBot";

export default function bot(app: Probot) {
  autoCcBot(app);
  autoLabelBot(app);
  verifyDisableTestIssueBot(app);
  greenBot(app);
  // ciflowBot(app);
  ciflowPushTrigger(app);
  webhookToDynamo(app);
  triggerCircleCIWorkflows(app);
  mergeBot(app);
  labelBot(app);
}
