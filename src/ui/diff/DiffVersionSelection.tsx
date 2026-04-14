import { Select, Flex } from "antd";
import { useObservable } from "../../utils/UseObservable";
import { minecraftVersionIds } from "../../logic/MinecraftApi";
import { getLeftDiff, getRightDiff } from "../../logic/Diff";

const DiffVersionSelection = () => {
    const versions = useObservable(minecraftVersionIds);
    const leftVersion = useObservable(getLeftDiff().selectedVersion);
    const rightVersion = useObservable(getRightDiff().selectedVersion);

    return (
        <Flex align="center" gap={8}>
            <Select
                value={leftVersion || undefined}
                placeholder="Select left version"
                style={{ minWidth: 170 }}
                onChange={(v) => {
                    getLeftDiff().selectedVersion.next(v ?? null);
                }}
            >
                {versions?.map(v => (
                    <Select.Option key={v} value={v} disabled={v === rightVersion}>{v}</Select.Option>
                ))}
            </Select>
            <span style={{ fontSize: 12, color: '#888' }}>→</span>
            <Select
                value={rightVersion || undefined}
                placeholder="Select right version"
                style={{ minWidth: 170 }}
                onChange={(v) => {
                    getRightDiff().selectedVersion.next(v ?? null);
                }}
            >
                {versions?.map(v => (
                    <Select.Option key={v} value={v} disabled={v === leftVersion}>{v}</Select.Option>
                ))}
            </Select>
        </Flex>
    );
};

export default DiffVersionSelection;
