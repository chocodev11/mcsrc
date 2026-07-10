// oxlint-disable typescript/no-base-to-string
import { Tree, Dropdown, message } from 'antd';
import type { TreeDataNode, TreeProps, MenuProps } from 'antd';
import { CaretDownFilled } from '@ant-design/icons';
import { combineLatest, map, Observable, shareReplay } from 'rxjs';
import { classesList } from '../logic/JarFile';
import { useObservable } from '../utils/UseObservable';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Key } from 'antd/es/table/interface';
import { openTab } from '../logic/Tabs';
import { minecraftJar, type MinecraftJar } from '../logic/MinecraftApi';
import { decompileClass } from '../logic/Decompiler';
import { openReferences, selectedFile } from '../logic/State';
import { compactPackages } from '../logic/Settings';
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils';

function renderFolderNamedIcon(folderName: string) {
    return <FolderIcon folderName={folderName} width={18} height={18} className="symbol-file-tree-icon" />;
}

function renderJavaFileIcon(fileName: string) {
    return <FileIcon fileName={fileName} width={18} height={18} className="symbol-file-tree-icon" />;
}

const fileTree: Observable<TreeDataNode[]> = combineLatest([
    classesList,
    compactPackages.observable
]).pipe(
    map(([classNames, compact]) => {
        const dirs = new Map<string, TreeDataNode[]>();
        dirs.set('', []);

        for (const classPath of classNames) {
            if (classPath.includes('$')) continue;

            const className = classPath.replace('.class', '');
            const i = className.lastIndexOf('/');
            const dirPath = className.slice(0, i);

            if (!dirs.has(dirPath)) {
                const parts = dirPath.split('/');
                parts.forEach((p, i) => {
                    const parent = parts.slice(0, i).join('/');
                    const current = parent === '' ? p : `${parent}/${p}`;

                    if (!dirs.has(current)) {
                        dirs.set(current, []);
                        dirs.get(parent)!.push({
                            title: p,
                            key: current,
                            icon: renderFolderNamedIcon(p),
                            children: [],
                            isLeaf: false,
                        });
                    };
                });
            };

            dirs.get(dirPath)!.push({
                title: className.slice(i + 1),
                key: classPath,
                isLeaf: true,
                icon: renderJavaFileIcon(`${className.slice(i + 1)}.java`),
            });
        }

        function traverse(dir: string, parent: TreeDataNode) {
            const nodes = dirs.get(dir)!;

            if (compact && nodes.length === 1 && !nodes[0].isLeaf) {
                const node = nodes[0];
                parent.title = `${parent.title?.toString()}/${node.title?.toString()}`;
                traverse(node.key as string, parent);
            } else {
                for (const node of nodes) {
                    parent.children!.push(node);

                    if (!node.isLeaf) {
                        traverse(node.key as string, node);
                    };
                }
            }

            parent.children!.sort((a, b) => {
                if (a.isLeaf && !b.isLeaf) return +1;
                if (!a.isLeaf && b.isLeaf) return -1;
                return a.title! < b.title! ? -1 : +1;
            });
        }

        const root: TreeDataNode[] = [];
        traverse('', { title: '', key: '', children: root });

        return root;
    }),
    shareReplay(1)
);

const selectedFileKeys = selectedFile.pipe(
    map(file => file ? [file] : [])
);

function getPathKeys(filePath: string): Key[] {
    const parts = filePath.split('/').slice(0, -1);
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        result.push(parts.slice(0, i + 1).join('/'));
    }
    return result;
}

const handleCopyContent = async (path: string, jar: MinecraftJar) => {
    try {
        message.loading({ content: 'Decompiling...', key: 'copy-content' });
        const result = await decompileClass(path, jar.jar);
        await navigator.clipboard.writeText(result.source);
        message.success({ content: 'Content copied to clipboard', key: 'copy-content' });
    } catch (e) {
        console.error(e);
        message.error({ content: 'Failed to copy content', key: 'copy-content' });
    }
};

interface ContextMenuInfo {
    x: number;
    y: number;
    key: string;
    isLeaf: boolean;
}

const getMenuItems = (
    contextMenu: ContextMenuInfo | null,
    handleCopyItem: (path: string) => void,
    jar: MinecraftJar | undefined
): MenuProps['items'] => {
    if (!contextMenu) return [];

    const path = contextMenu.key;
    const isFile = path.endsWith('.class');
    const packagePath = path.replace(/\//g, '.').replace('.class', '');
    const filename = path.split('/').pop() || '';
    const linkPath = path.replace('.class', '');
    const link = jar ? `https://mcsrc.dev/1/${jar.version}/${linkPath}` : '';

    const renderLabel = (title: string, value: string) => (
        <div className="sidebar-context-menu-label">
            <span className="sidebar-context-menu-title">{title}</span>
            <div className="sidebar-context-menu-meta">
                <span className="sidebar-context-menu-value" title={value}>
                    {value}
                </span>
            </div>
        </div>
    );

    return [
        {
            key: 'copy-package-path',
            label: renderLabel('Copy Package Path', packagePath),
            onClick: () => {
                void navigator.clipboard.writeText(packagePath);
                message.success('Package Path copied');
            }
        },
        {
            key: 'copy-path',
            label: renderLabel('Copy Path', path),
            onClick: () => {
                void navigator.clipboard.writeText(path);
                message.success('Path copied');
            }
        },
        {
            key: 'copy-filename',
            label: renderLabel('Copy Filename', filename),
            onClick: () => {
                void navigator.clipboard.writeText(filename);
                message.success('Filename copied');
            }
        },
        {
            key: 'copy-link',
            label: renderLabel('Copy Link', link),
            onClick: () => {
                if (link) {
                    void navigator.clipboard.writeText(link);
                    message.success('Link copied');
                }
            },
            disabled: !link || !isFile
        },
        {
            key: 'copy-content',
            label: 'Copy File Content',
            onClick: () => handleCopyItem(contextMenu.key),
            disabled: !isFile
        },
        {
            key: 'find-all-references',
            label: 'Find All References',
            onClick: () => {
                const cleanPath = path.replace('.class', '');
                openReferences(cleanPath);
            },
            disabled: !isFile
        },
    ];
};

const FileList = () => {
    const [expandedKeys, setExpandedKeys] = useState<Key[]>();
    const [contextMenu, setContextMenu] = useState<ContextMenuInfo | null>(null);

    const jar = useObservable(minecraftJar);
    const selectedKeys = useObservable(selectedFileKeys);
    const classes = useObservable(classesList);
    const onSelect: TreeProps['onSelect'] = useCallback((selectedKeys: Key[]) => {
        if (selectedKeys.length === 0) return;
        if (!classes || !classes.includes(selectedKeys[0] as string)) return;
        openTab(selectedKeys.join("/"));
    }, [classes]);

    const treeData = useObservable(fileTree);

    useEffect(() => {
        if (expandedKeys === undefined) {
            if (selectedKeys?.[0]) {
                setExpandedKeys(getPathKeys(selectedKeys[0] as string));
            } else {
                setExpandedKeys(['net', 'net/minecraft']);
            }
        }
    }, [expandedKeys, selectedKeys]);

    useEffect(() => {
        if (selectedKeys?.[0] && expandedKeys !== undefined) {
            const pathKeys = getPathKeys(selectedKeys[0] as string);
            const newKeys = [...new Set([...expandedKeys, ...pathKeys])];
            if (newKeys.length !== expandedKeys.length) {
                setExpandedKeys(newKeys);
            }
        }
    }, [selectedKeys, expandedKeys]);

    useEffect(() => {
        const closeMenu = () => setContextMenu(null);
        document.addEventListener('click', closeMenu);
        return () => document.removeEventListener('click', closeMenu);
    }, []);

    const onRightClick: TreeProps['onRightClick'] = useCallback(({ event, node }: any) => {
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            key: node.key as string,
            isLeaf: !!node.isLeaf
        });
    }, []);

    const menuItems = useMemo(() => getMenuItems(contextMenu, (path) => {
        if (jar) {
            void handleCopyContent(path, jar);
        }
    }, jar), [contextMenu, jar]);

    return (
        <>
            <Tree.DirectoryTree
                showLine
                motion={0}
                switcherIcon={<CaretDownFilled />}
                selectedKeys={selectedKeys}
                onSelect={onSelect}
                treeData={treeData}
                expandedKeys={expandedKeys ?? []}
                onExpand={setExpandedKeys}
                onRightClick={onRightClick}
                titleRender={(nodeData) => (
                    <span style={{ userSelect: "none" }}>{nodeData.title?.toString()}</span>
                )}
            />
            {contextMenu && (
                <div key={contextMenu.key + contextMenu.x + contextMenu.y} style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1000 }}>
                    <Dropdown
                        menu={{ items: menuItems }}
                        classNames={{ root: 'sidebar-context-menu' }}
                        open={true}
                        trigger={['click']}
                    >
                        <span />
                    </Dropdown>
                </div>
            )}
        </>
    );
};

export default FileList;
