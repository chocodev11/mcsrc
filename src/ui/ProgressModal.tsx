import { Modal, Progress, Space, Typography } from "antd";
import { downloadProgress } from "../logic/MinecraftApi";
import { useObservable } from "../utils/UseObservable";
import { leftDownloadProgress, rightDownloadProgress } from "../logic/Diff";
import { diffLeftselectedMinecraftVersion, diffRightselectedMinecraftVersion, diffView } from "../logic/State";

const ProgressModal = () => {
    const isDiffView = useObservable(diffView) || false;
    const progress = useObservable(downloadProgress);
    const leftProgress = useObservable(leftDownloadProgress);
    const rightProgress = useObservable(rightDownloadProgress);
    const leftVersion = useObservable(diffLeftselectedMinecraftVersion);
    const rightVersion = useObservable(diffRightselectedMinecraftVersion);

    const compareDownloads = [
        { version: leftVersion, progress: leftProgress },
        { version: rightVersion, progress: rightProgress },
    ].filter(item => item.progress !== undefined);

    const modalOpen = isDiffView ? compareDownloads.length > 0 : progress !== undefined;
    const title = isDiffView ? "Downloading compare jars" : "Downloading server jar";

    return (
        <Modal
            title={title}
            open={modalOpen}
            footer={null}
            closable={false}
        >
            {isDiffView ? (
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    {compareDownloads.map((item, index) => (
                        <div key={`${item.version ?? "unknown"}-${index}`}>
                            <Typography.Text type="secondary">
                                {item.version ?? "Unknown"}
                            </Typography.Text>
                            <Progress percent={item.progress ?? 0} />
                        </div>
                    ))}
                </Space>
            ) : (
                <Progress percent={progress ?? 0} />
            )}
        </Modal>
    );
};

export default ProgressModal;
