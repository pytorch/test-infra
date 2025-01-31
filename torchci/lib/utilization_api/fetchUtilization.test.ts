import { flattenTS } from "./fetchUtilization";
import { TimeSeriesDbData } from "./types";

const TEST_GPU_USAGE_11 = {
    uuid: "uuid-1",
    util_percent: {
        avg: 10,
        max: 10,
    },
    mem_util_percent:{
        avg: 10,
        max: 10,
    }
}
const TEST_GPU_USAGE_22 = {
    uuid: "uuid-2",
    util_percent: {
        avg: 20,
        max: 20,
    },
    mem_util_percent:{
        avg: 20,
        max: 20,
    }
}

const TEST_GPU_USAGE_13 = {
    uuid: "uuid-1",
    util_percent: {
        avg: 30,
        max: 30,
    },
    mem_util_percent:{
        avg: 30,
        max: 30,
    }
}

const TEST_GPU_USAGE_24 = {
    uuid: "uuid-2",
    util_percent: {
        avg: 40,
        max: 40,
    },
    mem_util_percent:{
        avg: 40,
        max: 40,
    }
}

const TEST_DATA_1 = {
    ts: "2023-10-10 13:00:00",
    data:JSON.stringify({
         cpu: {
           avg: 10,
           max: 10
         },
         memory: {
           avg: 10,
           max: 10
         },
         gpu_usage:[
            TEST_GPU_USAGE_11,
            TEST_GPU_USAGE_22,
        ],
     }),
     tags:[]
 }

const TEST_DATA_2 ={
    ts: "2023-10-10 16:00:00",
    data: JSON.stringify({
            cpu: {
            avg: 20,
            max: 20
            },
            memory: {
            avg: 20,
            max: 20
            },
            gpu_usage:[
            TEST_GPU_USAGE_13,
            TEST_GPU_USAGE_24,
            ],
        }),
        tags:[]
    }

const TEST_DATA_3 ={
    ts: "2023-10-10 18:00:00",
    data: JSON.stringify({
            cpu: {
            avg: 2.43,
            max: 6.4
            },
            memory: {
            avg: 5.25,
            max: 5.8
            },
            gpu_usage: null,
        }),
        tags:[]
    }

 const BASE_TEST_LIST:TimeSeriesDbData[] = [
    TEST_DATA_1,
    TEST_DATA_2,
    ]

describe('Test timestamp flattening', () => {
    it('should generate map of timestamp', () => {
        const res = flattenTS(BASE_TEST_LIST);
        const resKeys = Array.from(res.keys())
        console.log(res)
        // assert map keys
        expect(resKeys.length).toEqual(12);
        expect(resKeys.filter(x => x.includes("cpu")).length).toEqual(2);
        expect(resKeys.filter(x => x.includes("gpu")).length).toEqual(8);
        expect(resKeys.filter(x => x.includes("memory")).length).toEqual(2);
        expect(resKeys.filter(x => x.includes("max")).length).toEqual(6);
        expect(resKeys.filter(x => x.includes("avg")).length).toEqual(6);

        // assert map values
         resKeys.forEach((key,_) => {
            expect(res.get(key)?.length).toEqual(2);
         });

        const cpu_avg_ts = res.get('cpu|avg')
        expect(cpu_avg_ts).toEqual([
            { ts: '2023-10-10 13:00:00', value: 10 },
            { ts: '2023-10-10 16:00:00', value: 20 }]);

        const gpu_1_max = res.get('gpu_usage|uuid-1|mem_util_percent|max')
        expect(gpu_1_max).toEqual([
            { ts: '2023-10-10 13:00:00', value: 10 },
            { ts: '2023-10-10 16:00:00', value: 30 }]);

    });
  });
