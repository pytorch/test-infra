import { Probot } from "probot";
import ciflowPushTrigger from "./ciflowPushTrigger";
import webhookToDynamo from "./webhookToDynamo";

export default function bot(app: Probot) {
  ciflowPushTrigger(app);
  webhookToDynamo(app);
}
