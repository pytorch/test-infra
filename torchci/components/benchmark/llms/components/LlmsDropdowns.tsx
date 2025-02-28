import { Stack } from "@mui/system"
import dayjs from "dayjs"
import { TimeRangePicker } from "pages/metrics"
import { ARCH_NAMES, LlmsGraphPanelProps } from "../common"
import GranularityPicker from "components/GranularityPicker"
import { DTypePicker } from "components/benchmark/ModeAndDTypePicker"
import { DEFAULT_ARCH_NAME, DEFAULT_MODEL_NAME } from "./common"
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker"


export default function LlmsDropdowns(
{
    setProps = ()=>{},
    props,
    optionListMap}:{
    setProps: (props:LlmsGraphPanelProps) => void,
    props: LlmsGraphPanelProps,
    optionListMap: any
}
){

    return (
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <TimeRangePicker
            startTime={props.startTime}
            stopTime={props.stopTime}
            setStartTime={(time:any)=>{
              setProps({...props, startTime: dayjs(time)})
            }}
            setStopTime={(time:any)=>{
              setProps({...props, stopTime: dayjs(time)})
            }}
            timeRange={props.timeRange}
            setTimeRange={(val:any)=>{
              setProps({...props, timeRange: val})
            }}
            setGranularity={(val:any)=>{
              setProps({...props, granularity: val})
            }}
          />
          <GranularityPicker
            granularity={props.granularity}
            setGranularity={(val:any)=>{
              setProps({...props, granularity: val})
            }}
          />
          <DTypePicker
            dtype={props.modelName}
            setDType={(val:any)=>{
              setProps({...props, modelName: val})
            }}
            dtypes={optionListMap.modelNames}
            label={"Model"}
          />
        {optionListMap.backendNames.length > 1 && (
          <DTypePicker
            dtype={props.backendName}
            setDType={(val:any)=>{
              setProps({...props, backendName: val})
            }}
            dtypes={optionListMap.backendNames}
            label={"Backend"}
          />
        )}
        {optionListMap.modeNames.length > 1 && (
          <DTypePicker
            dtype={props.modeName}
            setDType={(val:any)=>{
              setProps({...props, modeName: val})
            }}
            dtypes={optionListMap.modeNames}
            label={"Mode"}
          />
        )}
        {optionListMap.dtypeNames.length > 1 && (
          <DTypePicker
            dtype={props.dtypeName}
            setDType={(val:any)=>{
              setProps({...props, dtypeName: val})
            }}
            dtypes={optionListMap.dtypeNames}
            label={"DType"}
          />
        )}
        {props.repoName === "pytorch/executorch" && (
          <DTypePicker
            dtype={props.archName}
            setDType={(val:any)=>{
              setProps({...props, archName: val})
            }}
            dtypes={[DEFAULT_ARCH_NAME, ...ARCH_NAMES[props.repoName]]}
            label={"Platform"}
          />
        )}
        <DTypePicker
          dtype={props.deviceName}
          setDType={(val:any)=>{
            setProps({...props, deviceName: val})
          }}
          dtypes={optionListMap.deviceNames}
          label={"Device"}
        />
      </Stack>
    )


}
