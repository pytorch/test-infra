import { getDynamoClient } from "lib/dynamo";
import { PytorchbotParams } from "./pytorchBotHandler";

const TableName = "pytorchbot-logs";

class PytorchBotLogger {
  params: PytorchbotParams;
  client: any;

  constructor(params: PytorchbotParams) {
    this.params = params;
    delete this.params.ctx;
    try {
      var config = {
        marshallOptions: {
          convertEmptyValues: true,
          removeUndefinedValues: true,
        }
      }
      this.client = getDynamoClient(config);
    } catch (exception) {
      console.error("Error getting Dynamo Client", exception);
    }
  }

  async log(event: string, extra_data: object = {}) {
    try {
      const log = {
        TableName: TableName,
        Item: {
          dynamoKey: `${this.params.owner}/${this.params.repo}/${this.params.prNum}/${this.params.commentId}`,
          item: { ...this.params, event, extra_data },
        },
      };
      if (process.env.NODE_ENV === "production") {
        await this.client.put(log);
      } else {
        console.log(log);
      }
    } catch (exception) {
      console.error("Error writing to dynamo", exception);
    }
  }
}

export default PytorchBotLogger;
