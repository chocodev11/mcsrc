import { Button, Divider, Flex, Input, Spin } from "antd";
import Header from "./Header";
import FileList from "./FileList";
import type { InputRef, SearchProps } from "antd/es/input";
import { useObservable } from "../utils/UseObservable";
import { isSearching } from "../logic/JarFile";
import SearchResults from "./SearchResults";
import ReferenceResults from "./ReferenceResults";
import { formatReferenceQuery, isViewingReferences, referenceSearchState } from "../logic/FindAllReferences";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { focusSearchEvent } from "../logic/Keybinds";
import { useEffect, useRef } from "react";
import { closeReferences, referencesQuery, searchQuery } from "../logic/State";

const { Search } = Input;

const SideBar = () => {
    const showReference = useObservable(isViewingReferences);
    const currentReferenceQuery = useObservable(referencesQuery);
    const referenceState = useObservable(referenceSearchState);
    const focusSearch = useObservable(focusSearchEvent);
    const searchRef = useRef<InputRef>(null);

    useEffect(() => {
        if (focusSearch) {
            closeReferences();
            searchRef?.current?.focus();
        }
    }, [focusSearch]);

    useEffect(() => {
        if (focusSearch && !showReference) {
            searchRef?.current?.focus();
        }
    }, [focusSearch, showReference]);

    const onChange: SearchProps['onChange'] = (e) => {
        searchQuery.next(e.target.value);
    };

    const onBackClick = () => {
        closeReferences();
    };

    return (
        <Flex vertical className="sidebar-panel" style={{ height: "100%" }}>
            <Header />
            {showReference ? (
                <div className="reference-shell">
                    <div className="reference-toolbar">
                        <Button
                            className="reference-back-button"
                            onClick={onBackClick}
                            icon={<ArrowLeftOutlined />}
                            size="small"
                            type="text"
                        />
                        <div className="reference-title">
                            <span className="codicon codicon-references" />
                            <span>References</span>
                        </div>
                    </div>
                    <Flex vertical className="reference-header">
                        <div className="reference-query-title">
                            {formatReferenceQuery(currentReferenceQuery || "")}
                        </div>
                        <div className="reference-status-line">
                            {referenceState?.status === "loading" && <><Spin size="small" /> Searching...</>}
                            {referenceState?.status === "success" && `${referenceState.results.length} reference${referenceState.results.length === 1 ? "" : "s"}`}
                            {referenceState?.status === "error" && "Search failed"}
                        </div>
                    </Flex>
                </div>
            ) : (
                <div className="sidebar-search">
                    <Search ref={searchRef} placeholder="Search classes" allowClear onChange={onChange}></Search>
                </div>
            )}
            <Divider size="small" />
            <div className="sidebar-content">
                <FileListOrSearchResults />
            </div>
        </Flex>
    );
};

const FileListOrSearchResults = () => {
    const showSearchResults = useObservable(isSearching);
    const showReference = useObservable(isViewingReferences);

    if (showReference) {
        return <ReferenceResults />;
    } else if (showSearchResults) {
        return <SearchResults />;
    } else {
        return <FileList />;
    }
};

export default SideBar;
