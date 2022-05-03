// @ts-nocheck
import axios from "axios"
import { Context, Probot } from "probot";
import * as utils from "./utils";

interface Params {
  [param: string]: boolean;
}

interface LabelParams {
  parameter?: string;
  default_true_on?: {
    branches?: string[];
    tags?: string[];
    pull_request?: null;
  };
  set_to_false?: boolean;
}

interface Config {
  default_params?: Params;
  labels_to_circle_params: {
    [label: string]: LabelParams;
  };
}

export const configName = "pytorch-circleci-labels.yml";
export const circleAPIUrl = "https://circleci.com";
const circleToken = process.env.CIRCLE_TOKEN;
const repoMap = new Map<string, Config | {}>();

async function loadConfig(context: Context): Promise<Config | {}> {
  const repoKey = utils.repoKey(context);
  let configObj = repoMap.get(repoKey);
  if (configObj === undefined) {
    context.log.info({ repoKey }, "loadConfig");
    configObj = (await context.config(configName)) as Config | {};
    if (configObj === null || !configObj["labels_to_circle_params"]) {
      return {};
    }
    context.log.info({ configObj }, "loadConfig");
    repoMap.set(repoKey, configObj);
  }
  return repoMap.get(repoKey);
}

function isValidConfig(
  context: Context,
  config: Config | {}
): config is Config {
  if (Object.keys(config).length === 0 || !config["labels_to_circle_params"]) {
    context.log.info(
      `No valid configuration found for repository ${utils.repoKey(context)}`
    );
    return false;
  }
  return true;
}

function stripReference(reference: string): string {
  return reference.replace(/refs\/(heads|tags)\//, "");
}

async function getAppliedLabels(context: Context): Promise<string[]> {
  const appliedLabels = new Array<string>();
  // Check if we already have the applied labels in our context payload
  if (context.payload["pull_request"]["labels"]) {
    for (const label of context.payload["pull_request"]["labels"]) {
      appliedLabels.push(label["name"]);
    }
  }
  context.log.info({ appliedLabels }, "getAppliedLabels");
  return appliedLabels;
}

async function triggerCircleCI(
  context: Context,
  data: object
): Promise<void> {
  const repoKey = utils.repoKey(context);
  context.log.info({ repoKey, data }, "triggerCircleCI");
  const resp = await axios.post(
    `${circleAPIUrl}${circlePipelineEndpoint(repoKey)}`,
    data,
    {
      validateStatus: () => {
        return true;
      },
      auth: {
        username: circleToken,
        password: "",
      },
    }
  );

  if (resp.status !== 201) {
    throw Error(
      `Error triggering downstream circleci workflow (${resp.status
      }): ${JSON.stringify(resp.data)}`
    );
  }
  context.log.info({ data }, `Build triggered successfully for ${repoKey}`);
}

export function circlePipelineEndpoint(repoKey: string): string {
  return `/api/v2/project/github/${repoKey}/pipeline`;
}

function invert(label: string): string {
  return label.replace(/^ci\//, "ci/no-");
}

export function genCircleParametersForPR(
  config: Config,
  context: Context,
  appliedLabels: string[]
): Params {
  context.log.info({ config, appliedLabels }, "genParametersForPR");
  const {
    default_params: parameters = {},
    labels_to_circle_params: labelsToParams,
  } = config;
  context.log.info({ parameters }, "genCircleParametersForPR (default_params)");
  for (const label of Object.keys(labelsToParams)) {
    const defaultTrueOn = labelsToParams[label].default_true_on || {};
    if (
      appliedLabels.includes(label) ||
      (defaultTrueOn.pull_request !== undefined &&
        !appliedLabels.includes(invert(label)))
    ) {
      const { parameter } = labelsToParams[label];
      if (parameter !== undefined) {
        context.log.info(
          { parameter },
          "genCircleParametersForPR setting parameter to true"
        );
        parameters[parameter] = true;
      }
      if (labelsToParams[label].set_to_false) {
        const falseParams = labelsToParams[label].set_to_false;
        // There's potential for labels to override each other which we should
        // probably be careful of
        for (const falseLabel of Object.keys(falseParams)) {
          const param = falseParams[falseLabel];
          context.log.info(
            { param },
            "genCircleParametersForPR (set_to_false) setting param to false"
          );
          parameters[param] = false;
        }
      }
    }
  }
  return parameters;
}

function genCircleParametersForPush(
  config: Config,
  context: Context
): Params {
  const {
    default_params: parameters = {},
    labels_to_circle_params: labelsToParams,
  } = config;
  context.log.info(
    { parameters },
    "genCircleParametersForPush (default_params)"
  );
  const onTag: boolean = context.payload["ref"].startsWith("refs/tags");
  const strippedRef: string = stripReference(context.payload["ref"]);
  for (const label of Object.keys(labelsToParams)) {
    context.log.info({ label }, "genParametersForPush");
    const defaultTrueOn = labelsToParams[label].default_true_on;
    if (!defaultTrueOn) {
      context.log.info(
        { label },
        "genParametersForPush (no default_true_on found)"
      );
      continue;
    }
    const refsToMatch = onTag ? "tags" : "branches";
    context.log.info({ defaultTrueOn, refsToMatch, strippedRef });
    for (const pattern of defaultTrueOn[refsToMatch] || []) {
      context.log.info({ pattern }, "genParametersForPush");
      if (strippedRef.match(pattern)) {
        const { parameter } = labelsToParams[label];
        if (parameter !== undefined) {
          context.log.info(
            { parameter },
            "genParametersForPush setting parameter to true"
          );
          parameters[parameter] = true;
        }
        if (labelsToParams[label].set_to_false) {
          const falseParams = labelsToParams[label].set_to_false;
          // There's potential for labels to override each other which we should
          // probably be careful of
          for (const falseLabel of Object.keys(falseParams)) {
            const param = falseParams[falseLabel];
            context.log.info(
              { param },
              "genParametersForPush (set_to_false) setting param to false"
            );
            parameters[param] = false;
          }
        }
      }
    }
  }
  return parameters;
}

async function runBotForPR(context: Context): Promise<void> {
  try {
    let triggerBranch = context.payload["pull_request"]["head"]["ref"];
    if (context.payload["pull_request"]["head"]["repo"]["fork"]) {
      triggerBranch = `pull/${context.payload["pull_request"]["number"]}/head`;
    }
    context.log.info({ triggerBranch }, "runBotForPR");
    const config = await loadConfig(context);
    if (!isValidConfig(context, config)) {
      return;
    }
    const labels = await getAppliedLabels(context);
    const parameters = genCircleParametersForPR(config, context, labels);
    context.log.info({ config, labels, parameters }, "runBot");
    if (Object.keys(parameters).length !== 0) {
      await triggerCircleCI(context, {
        branch: triggerBranch,
        parameters,
      });
    } else {
      context.log.info(
        `No labels applied for ${context.payload["number"]}, not triggering an extra CircleCI build`
      );
    }
  } catch (err) {
    context.log.error({ err }, "runBotForPR");
  }
}

async function runBotForPush(context: Context): Promise<void> {
  try {
    const rawRef = context.payload["ref"];
    const onTag: boolean = rawRef.startsWith("refs/tags");
    const ref = stripReference(rawRef);
    context.log.info({ rawRef, onTag, ref }, "runBotForPush");
    const config = await loadConfig(context);
    if (!isValidConfig(context, config)) {
      return;
    }
    const parameters = genCircleParametersForPush(config, context);
    const refKey: string = onTag ? "tag" : "branch";
    context.log.info({ parameters }, "runBot");
    if (Object.keys(parameters).length !== 0) {
      await triggerCircleCI(context, {
        [refKey]: ref,
        parameters,
      });
    }
  } catch (err) {
    context.log.error({ err }, "runBotForPush");
  }
}

export function myBot(app: Probot): void {
  app.on("pull_request.labeled", runBotForPR);
  app.on("pull_request.synchronize", runBotForPR);
  app.on("push", runBotForPush);
}

export default myBot;
