import type { SQSHandler } from "aws-lambda";

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    console.log("\n\nMy SQS message body:", record.body);
    if (
      record.messageAttributes &&
      Object.keys(record.messageAttributes).length > 0
    ) {
      console.log(
        "\n\nMy SQS message attributes:",
        JSON.stringify(record.messageAttributes),
      );
    }
  }
};

export default handler;
