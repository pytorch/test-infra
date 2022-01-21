import { parseSubscriptions } from "../lib/bot/subscriptions";

describe("subscriptions", () => {
  test("complicated subscriptions", () => {
    expect(
      parseSubscriptions(`
This issue is used by [pytorch-probot](https://github.com/pytorch/pytorch-probot) to manage subscriptions to labels.  To subscribe yourself to a label, add a line \`* label @yourusername\`, or add your username to an existing line (space separated) in the body of this issue. **DO NOT COMMENT, COMMENTS ARE NOT RESPECTED BY THE BOT.**

As a courtesy to others, please do not edit the subscriptions of users who are not you.

* high priority @ezyang
* critical @ezyang
* module: binaries @ezyang
* module: autograd @ezyang
* module: complex @ezyang
* module: doc infra @ezyang
* module: ci @ezyang
* module: typing @ezyang
* module: dataloader @SsnL
* topic: bc-breaking @ezyang @SsnL
* topic: quansight @ezyang
* module: quantization @pytorch/quantization
    `)
    ).toStrictEqual({
      critical: ["ezyang"],
      "high priority": ["ezyang"],
      "module: autograd": ["ezyang"],
      "module: binaries": ["ezyang"],
      "module: ci": ["ezyang"],
      "module: complex": ["ezyang"],
      "module: dataloader": ["SsnL"],
      "module: doc infra": ["ezyang"],
      "module: typing": ["ezyang"],
      "topic: bc-breaking": ["ezyang", "SsnL"],
      "topic: quansight": ["ezyang"],
      "module: quantization": ["pytorch/quantization"],
    });
  });
  test("malformed subscriptions", () => {
    expect(
      parseSubscriptions(`
This issue is used by [pytorch-probot](https://github.com/pytorch/pytorch-probot) to manage subscriptions to labels.  To subscribe yourself to a label, add a line \`* label @yourusername\`, or add your username to an existing line (space separated) in the body of this issue. **DO NOT COMMENT, COMMENTS ARE NOT RESPECTED BY THE BOT.**

As a courtesy to others, please do not edit the subscriptions of users who are not you.

* high priority @ezyang
* critical @ezyang
* module: binaries
* module: autograd @ezyang
    `)
    ).toStrictEqual({
      critical: ["ezyang"],
      "high priority": ["ezyang"],
      "module: autograd": ["ezyang"],
    });
  });
});
