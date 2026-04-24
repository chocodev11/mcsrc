import type { VersionsList } from "./types.ts";

export const VERSIONS_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

// Keep this list in sync with src/logic/MinecraftApi.ts until the browser and MCP
// version pipelines are fully shared.
export const EXPERIMENTAL_VERSIONS: VersionsList = {
    versions: [
        {
            id: "25w45a_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/25w45a_unobfuscated.json",
            time: "2025-11-04T14:07:08+00:00",
            releaseTime: "2025-11-04T14:07:08+00:00",
            sha1: "7a3c149f148b6aa5ac3af48c4f701adea7e5b615",
        },
        {
            id: "25w46a_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/25w46a_unobfuscated.json",
            time: "2025-11-11T13:20:54+00:00",
            releaseTime: "2025-11-11T13:20:54+00:00",
            sha1: "314ade2afeada364047798e163ef8e82427c69e1",
        },
        {
            id: "1.21.11-pre1_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-pre1_unobfuscated.json",
            time: "2025-11-19T08:30:46+00:00",
            releaseTime: "2025-11-19T08:30:46+00:00",
            sha1: "9c267f8dda2728bae55201a753cdd07b584709f1",
        },
        {
            id: "1.21.11-pre2_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-pre2_unobfuscated.json",
            time: "2025-11-21T12:07:21+00:00",
            releaseTime: "2025-11-21T12:07:21+00:00",
            sha1: "2955ce0af0512fdfe53ff0740b017344acf6f397",
        },
        {
            id: "1.21.11-pre3_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-pre3_unobfuscated.json",
            time: "2025-11-25T14:14:30+00:00",
            releaseTime: "2025-11-25T14:14:30+00:00",
            sha1: "579bf3428f72b5ea04883d202e4831bfdcb2aa8d",
        },
        {
            id: "1.21.11-pre4_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-pre4_unobfuscated.json",
            time: "2025-12-01T13:40:12+00:00",
            releaseTime: "2025-12-01T13:40:12+00:00",
            sha1: "410ce37a2506adcfd54ef7d89168cfbe89cac4cb",
        },
        {
            id: "1.21.11-pre5_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-pre5_unobfuscated.json",
            time: "2025-12-03T13:34:06+00:00",
            releaseTime: "2025-12-03T13:34:06+00:00",
            sha1: "1028441ca6d288bbf2103e773196bf524f7260fd",
        },
        {
            id: "1.21.11-rc1_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-rc1_unobfuscated.json",
            time: "2025-12-04T15:56:55+00:00",
            releaseTime: "2025-12-04T15:56:55+00:00",
            sha1: "5d3ee0ef1f0251cf7e073354ca9e085a884a643d",
        },
        {
            id: "1.21.11-rc2_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-rc2_unobfuscated.json",
            time: "2025-12-05T11:57:45+00:00",
            releaseTime: "2025-12-05T11:57:45+00:00",
            sha1: "9282a3fb154d2a425086c62c11827281308bf93b",
        },
        {
            id: "1.21.11-rc3_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11-rc3_unobfuscated.json",
            time: "2025-12-08T13:59:34+00:00",
            releaseTime: "2025-12-08T13:59:34+00:00",
            sha1: "ce3f7ac6d0e9d23ea4e5f0354b91ff15039d9931",
        },
        {
            id: "1.21.11_unobfuscated",
            type: "unobfuscated",
            url: "https://maven.fabricmc.net/net/minecraft/1_21_11_unobfuscated.json",
            time: "2025-12-09T12:43:15+00:00",
            releaseTime: "2025-12-09T12:43:15+00:00",
            sha1: "327be7759157b04495c591dbb721875e341877af",
        }
    ]
};
