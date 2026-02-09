import { PYTORCH_AO_MICRO_API_REPORT_CONFIG } from "../teams/torchao/ao_micro_api_config";
import { PYTORCH_OPERATOR_MICROBENCHMARK_ID_REPORT_CONFIG } from "../teams/torchao/config";

const configs: Record<string, any> = {
  torchao_micro_api_benchmark: PYTORCH_AO_MICRO_API_REPORT_CONFIG,
  pytorch_operator_microbenchmark:
    PYTORCH_OPERATOR_MICROBENCHMARK_ID_REPORT_CONFIG,
};

export function getRegressionConfig(id: string) {
  return configs[id] ?? {};
}
