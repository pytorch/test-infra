import { Probot } from "probot";
import autoCcBot from "./autoCcBot";
import autoLabelBot from "./autoLabelBot";
import CIFlowBot from "./ciflowBot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import webhookToDynamo from "./webhookToDynamo";
import verifyDisableTestIssueBot from "./verifyDisableTestIssueBot";
import mergeBot from "./mergeBot";

export default function bot(app: Probot) {
  autoCcBot(app);
  autoLabelBot(app);
  verifyDisableTestIssueBot(app);
  CIFlowBot.main(app);
  ciflowPushTrigger(app);
  webhookToDynamo(app);
  mergeBot(app);
}
