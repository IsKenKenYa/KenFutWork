// 由 scripts/刷新模型能力快照.ts 生成（勿手改）。数据源 models.dev api.json（MIT），
// 白名单裁剪 + 字段投影见 ./models-dev-snapshot.ts；定位是非权威 UI 提示（docs/future/05 §4）。
export const MODELS_DEV_SNAPSHOT = {
  "openai": {
    "name": "OpenAI",
    "doc": "https://platform.openai.com/docs/models",
    "env": [
      "OPENAI_API_KEY"
    ],
    "models": {
      "gpt-5-nano": {
        "id": "gpt-5-nano",
        "name": "GPT-5 Nano",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.05,
          "output": 0.4,
          "cache_read": 0.005
        }
      },
      "gpt-4.1-nano": {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.025
        }
      },
      "gpt-4o-2024-05-13": {
        "id": "gpt-4o-2024-05-13",
        "name": "GPT-4o (2024-05-13)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-05-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 5,
          "output": 15
        }
      },
      "gpt-5-pro": {
        "id": "gpt-5-pro",
        "name": "GPT-5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-10-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 272000
        },
        "cost": {
          "input": 15,
          "output": 120
        }
      },
      "chatgpt-image-latest": {
        "id": "chatgpt-image-latest",
        "name": "chatgpt-image-latest",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "gpt-5.6-sol": {
        "id": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 4,
          "output": 20,
          "cache_read": 0.4,
          "cache_write": 5
        }
      },
      "gpt-4o-2024-08-06": {
        "id": "gpt-4o-2024-08-06",
        "name": "GPT-4o (2024-08-06)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-08-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "gpt-6-astra": {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-04",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "gpt-5.2-pro": {
        "id": "gpt-5.2-pro",
        "name": "GPT-5.2 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 21,
          "output": 168
        }
      },
      "gpt-5.3-codex-spark": {
        "id": "gpt-5.3-codex-spark",
        "name": "GPT-5.3 Codex Spark",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-02-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "gpt-4.1-mini": {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 0.4,
          "output": 1.6,
          "cache_read": 0.1
        }
      },
      "gpt-5.4": {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2.5,
          "output": 15,
          "cache_read": 0.25
        }
      },
      "gpt-4-turbo": {
        "id": "gpt-4-turbo",
        "name": "GPT-4 Turbo",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-11-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 10,
          "output": 30
        }
      },
      "gpt-5.1": {
        "id": "gpt-5.1",
        "name": "GPT-5.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "o1": {
        "id": "o1",
        "name": "o1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-12-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 15,
          "output": 60,
          "cache_read": 7.5
        }
      },
      "gpt-4o": {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-05-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "gpt-5.6-luna": {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      "gpt-5.3-codex": {
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "gpt-4o-mini": {
        "id": "gpt-4o-mini",
        "name": "GPT-4o mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-07-18",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.075
        }
      },
      "gpt-image-1.5": {
        "id": "gpt-image-1.5",
        "name": "gpt-image-1.5",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-11-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "o1-pro": {
        "id": "o1-pro",
        "name": "o1-pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-03-19",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 150,
          "output": 600
        }
      },
      "gpt-4.1": {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 8,
          "cache_read": 0.5
        }
      },
      "text-embedding-ada-002": {
        "id": "text-embedding-ada-002",
        "name": "text-embedding-ada-002",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2022-12-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 1536
        },
        "cost": {
          "input": 0.1,
          "output": 0
        }
      },
      "gpt-image-1": {
        "id": "gpt-image-1",
        "name": "gpt-image-1",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-24",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "image"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "gpt-5.4-nano": {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 nano",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-17",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.25,
          "cache_read": 0.02
        }
      },
      "gpt-5.5-pro": {
        "id": "gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 30,
          "output": 180
        }
      },
      "gpt-image-1-mini": {
        "id": "gpt-image-1-mini",
        "name": "gpt-image-1-mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-09-26",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "gpt-5.4-mini": {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-17",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.75,
          "output": 4.5,
          "cache_read": 0.075
        }
      },
      "gpt-image-2": {
        "id": "gpt-image-2",
        "name": "gpt-image-2",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "image"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 1.25
        }
      },
      "gpt-3.5-turbo": {
        "id": "gpt-3.5-turbo",
        "name": "GPT-3.5-turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-03-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16385,
          "output": 4096
        },
        "cost": {
          "input": 0.5,
          "output": 1.5,
          "cache_read": 0
        }
      },
      "gpt-5.6": {
        "id": "gpt-5.6",
        "name": "GPT-5.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 4,
          "output": 20,
          "cache_read": 0.4,
          "cache_write": 5
        }
      },
      "text-embedding-3-small": {
        "id": "text-embedding-3-small",
        "name": "text-embedding-3-small",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-01-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8191,
          "output": 1536
        },
        "cost": {
          "input": 0.02,
          "output": 0
        }
      },
      "gpt-5-mini": {
        "id": "gpt-5-mini",
        "name": "GPT-5 Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.25,
          "output": 2,
          "cache_read": 0.025
        }
      },
      "gpt-5.4-pro": {
        "id": "gpt-5.4-pro",
        "name": "GPT-5.4 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 30,
          "output": 180
        }
      },
      "text-embedding-3-large": {
        "id": "text-embedding-3-large",
        "name": "text-embedding-3-large",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-01-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8191,
          "output": 3072
        },
        "cost": {
          "input": 0.13,
          "output": 0
        }
      },
      "gpt-5.6-terra": {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "gpt-4": {
        "id": "gpt-4",
        "name": "GPT-4",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-11-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 8192
        },
        "cost": {
          "input": 30,
          "output": 60
        }
      },
      "gpt-5.2": {
        "id": "gpt-5.2",
        "name": "GPT-5.2",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "gpt-5": {
        "id": "gpt-5",
        "name": "GPT-5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "gpt-5.2-chat-latest": {
        "id": "gpt-5.2-chat-latest",
        "name": "GPT-5.2 Chat",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "o4-mini": {
        "id": "o4-mini",
        "name": "o4-mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.275
        }
      },
      "gpt-realtime-2.1": {
        "id": "gpt-realtime-2.1",
        "name": "GPT-Realtime-2.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-06",
        "modalities": {
          "input": [
            "text",
            "audio",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32000
        },
        "cost": {
          "input": 4,
          "output": 24,
          "cache_read": 0.4,
          "input_audio": 32,
          "output_audio": 64
        }
      },
      "o3-mini": {
        "id": "o3-mini",
        "name": "o3-mini",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-12-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.55
        }
      },
      "o3": {
        "id": "o3",
        "name": "o3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 2,
          "output": 8,
          "cache_read": 0.5
        }
      },
      "o3-pro": {
        "id": "o3-pro",
        "name": "o3-pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-06-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 20,
          "output": 80
        }
      },
      "gpt-5.3-chat-latest": {
        "id": "gpt-5.3-chat-latest",
        "name": "GPT-5.3 Chat (latest)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "gpt-5.5": {
        "id": "gpt-5.5",
        "name": "GPT-5.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      "gpt-4o-2024-11-20": {
        "id": "gpt-4o-2024-11-20",
        "name": "GPT-4o (2024-11-20)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-11-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      }
    }
  },
  "anthropic": {
    "name": "Anthropic",
    "doc": "https://docs.anthropic.com/en/docs/about-claude/models",
    "env": [
      "ANTHROPIC_API_KEY"
    ],
    "models": {
      "claude-sonnet-4-6": {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "claude-opus-5": {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-24",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "claude-opus-4-5": {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-24",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "claude-fable-5-1": {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 0.25,
          "cache_write": 12.5
        }
      },
      "claude-opus-4-6": {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-04",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "claude-sonnet-4-5-20250929": {
        "id": "claude-sonnet-4-5-20250929",
        "name": "Claude Sonnet 4.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 64000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "claude-opus-4-7": {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "claude-haiku-4-5-20251001": {
        "id": "claude-haiku-4-5-20251001",
        "name": "Claude Haiku 4.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "claude-fable-5": {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "claude-haiku-4-5": {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "claude-sonnet-4-5": {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 64000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "claude-opus-4-8": {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "claude-sonnet-5": {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "claude-opus-4-5-20251101": {
        "id": "claude-opus-4-5-20251101",
        "name": "Claude Opus 4.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-24",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      }
    }
  },
  "google": {
    "name": "Google",
    "doc": "https://ai.google.dev/gemini-api/docs/models",
    "env": [
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "models": {
      "gemma-4-26b-a4b-it": {
        "id": "gemma-4-26b-a4b-it",
        "name": "Gemma 4 26B A4B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        }
      },
      "gemini-3.1-pro-preview-customtools": {
        "id": "gemini-3.1-pro-preview-customtools",
        "name": "Gemini 3.1 Pro Preview Custom Tools",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2
        }
      },
      "gemini-3.1-flash-lite-image": {
        "id": "gemini-3.1-flash-lite-image",
        "name": "Nano Banana 2 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-30",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 30
        }
      },
      "lyria-3-clip-preview": {
        "id": "lyria-3-clip-preview",
        "name": "Lyria 3 Clip Preview",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "gemini-2.5-flash-image": {
        "id": "gemini-2.5-flash-image",
        "name": "Nano Banana",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-26",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 30,
          "cache_read": 0.075
        }
      },
      "deep-research-max-preview-04-2026": {
        "id": "deep-research-max-preview-04-2026",
        "name": "Deep Research Max Preview (Apr-21-2026)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2
        }
      },
      "gemini-3-pro-image": {
        "id": "gemini-3-pro-image",
        "name": "Nano Banana Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 120
        }
      },
      "gemini-3.1-pro-preview": {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2
        }
      },
      "deep-research-preview-04-2026": {
        "id": "deep-research-preview-04-2026",
        "name": "Deep Research Preview (Apr-21-2026)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2
        }
      },
      "gemini-2.5-flash-lite": {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash-Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.01,
          "input_audio": 0.3
        }
      },
      "gemini-2.5-computer-use-preview-10-2025": {
        "id": "gemini-2.5-computer-use-preview-10-2025",
        "name": "Gemini 2.5 Computer Use Preview 10-2025",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 1.25,
          "output": 10
        }
      },
      "gemini-3.6-flash": {
        "id": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "cache_read": 0.075,
          "input_audio": 0.75
        }
      },
      "gemini-3.1-flash-lite": {
        "id": "gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 1.5,
          "cache_read": 0.025,
          "input_audio": 0.5
        }
      },
      "gemini-3.1-flash-live-preview": {
        "id": "gemini-3.1-flash-live-preview",
        "name": "Gemini 3.1 Flash Live Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 4.5,
          "input_audio": 3,
          "output_audio": 12
        }
      },
      "gemini-2.5-pro-preview-tts": {
        "id": "gemini-2.5-pro-preview-tts",
        "name": "Gemini 2.5 Pro Preview TTS",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 16384
        },
        "cost": {
          "input": 1,
          "output": 20
        }
      },
      "gemini-3.5-flash": {
        "id": "gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 1.5,
          "output": 9,
          "cache_read": 0.15,
          "input_audio": 1.5
        }
      },
      "veo-3.1-generate-preview": {
        "id": "veo-3.1-generate-preview",
        "name": "Veo 3.1",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 480,
          "output": 8192
        }
      },
      "gemini-3.1-flash-lite-preview": {
        "id": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 1.5,
          "cache_read": 0.025,
          "input_audio": 0.5
        }
      },
      "veo-3.1-fast-generate-preview": {
        "id": "veo-3.1-fast-generate-preview",
        "name": "Veo 3.1 fast",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 480,
          "output": 8192
        }
      },
      "gemini-2.5-flash-preview-tts": {
        "id": "gemini-2.5-flash-preview-tts",
        "name": "Gemini 2.5 Flash Preview TTS",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 16384
        },
        "cost": {
          "input": 0.5,
          "output": 10
        }
      },
      "gemini-embedding-001": {
        "id": "gemini-embedding-001",
        "name": "Gemini Embedding 001",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-05-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 2048,
          "output": 1
        },
        "cost": {
          "input": 0.15,
          "output": 0
        }
      },
      "gemini-3.1-flash-image": {
        "id": "gemini-3.1-flash-image",
        "name": "Nano Banana 2",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 65536
        },
        "cost": {
          "input": 0.5,
          "output": 60
        }
      },
      "gemini-3.5-flash-lite": {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "cache_read": 0.03
        }
      },
      "gemini-3-pro-image-preview": {
        "id": "gemini-3-pro-image-preview",
        "name": "Nano Banana Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 120
        }
      },
      "gemini-3.1-flash-tts-preview": {
        "id": "gemini-3.1-flash-tts-preview",
        "name": "Gemini 3.1 Flash TTS Preview",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 16384
        },
        "cost": {
          "input": 1,
          "output": 20
        }
      },
      "veo-3.1-lite-generate-preview": {
        "id": "veo-3.1-lite-generate-preview",
        "name": "Veo 3.1 lite",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-31",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 480,
          "output": 8192
        }
      },
      "gemini-flash-lite-latest": {
        "id": "gemini-flash-lite-latest",
        "name": "Gemini Flash-Lite Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "cache_read": 0.03
        }
      },
      "gemma-4-31b-it": {
        "id": "gemma-4-31b-it",
        "name": "Gemma 4 31B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        }
      },
      "gemini-embedding-2": {
        "id": "gemini-embedding-2",
        "name": "Gemini Embedding 2",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 1
        },
        "cost": {
          "input": 0.2,
          "output": 0,
          "input_audio": 6.5
        }
      },
      "gemini-3-flash-preview": {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.05,
          "input_audio": 1
        }
      },
      "gemini-3.8-flash": {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "cache_read": 0.075,
          "input_audio": 0.75
        }
      },
      "gemini-3.5-live-translate-preview": {
        "id": "gemini-3.5-live-translate-preview",
        "name": "Gemini 3.5 Live Translate Preview",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-09",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "audio",
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 32768
        },
        "cost": {
          "input": 3.5,
          "output": 21,
          "input_audio": 3.5,
          "output_audio": 21
        }
      },
      "lyria-3-pro-preview": {
        "id": "lyria-3-pro-preview",
        "name": "Lyria 3 Pro Preview",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "gemini-3.7-flash": {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "cache_read": 0.075,
          "input_audio": 0.75
        }
      },
      "gemini-2.5-pro": {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "gemini-flash-latest": {
        "id": "gemini-flash-latest",
        "name": "Gemini Flash Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "cache_read": 0.075,
          "input_audio": 0.75
        }
      },
      "gemini-3.1-flash-image-preview": {
        "id": "gemini-3.1-flash-image-preview",
        "name": "Nano Banana 2",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 65536
        },
        "cost": {
          "input": 0.5,
          "output": 60
        }
      },
      "gemini-omni-flash-preview": {
        "id": "gemini-omni-flash-preview",
        "name": "Gemini Omni Flash Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 1.5,
          "output": 17.5
        }
      },
      "gemini-2.5-flash": {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "cache_read": 0.03,
          "input_audio": 1
        }
      }
    }
  },
  "xai": {
    "name": "xAI",
    "doc": "https://docs.x.ai/docs/models",
    "env": [
      "XAI_API_KEY"
    ],
    "models": {
      "grok-4.3": {
        "id": "grok-4.3",
        "name": "Grok 4.3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 30000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "grok-4.20-0309-reasoning": {
        "id": "grok-4.20-0309-reasoning",
        "name": "Grok 4.20 (Reasoning)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 30000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "grok-4.20-multi-agent-0309": {
        "id": "grok-4.20-multi-agent-0309",
        "name": "Grok 4.20 Multi-Agent",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 30000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "grok-imagine-image": {
        "id": "grok-imagine-image",
        "name": "Grok Imagine Image",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-01-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "image",
            "pdf"
          ]
        },
        "limit": {
          "context": 16000,
          "output": 0
        }
      },
      "grok-imagine-video": {
        "id": "grok-imagine-video",
        "name": "Grok Imagine Video",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-01-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 1024,
          "output": 0
        }
      },
      "grok-4.5": {
        "id": "grok-4.5",
        "name": "Grok 4.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 500000,
          "output": 500000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.3
        }
      },
      "grok-build-0.1": {
        "id": "grok-build-0.1",
        "name": "Grok Build 0.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 1,
          "output": 2,
          "cache_read": 0.2
        }
      },
      "grok-imagine-video-1.5": {
        "id": "grok-imagine-video-1.5",
        "name": "Grok Imagine Video 1.5",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-05-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "pdf"
          ],
          "output": [
            "video"
          ]
        },
        "limit": {
          "context": 1024,
          "output": 0
        }
      },
      "grok-imagine-image-2.0": {
        "id": "grok-imagine-image-2.0",
        "name": "Grok Imagine Image 2.0",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-08-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "image",
            "pdf"
          ]
        },
        "limit": {
          "context": 64000,
          "output": 0
        }
      },
      "grok-4.6": {
        "id": "grok-4.6",
        "name": "Grok 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 500000,
          "output": 500000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      "grok-imagine-image-quality": {
        "id": "grok-imagine-image-quality",
        "name": "Grok Imagine Image Quality",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "image",
            "pdf"
          ]
        },
        "limit": {
          "context": 16000,
          "output": 0
        }
      },
      "grok-4.20-0309-non-reasoning": {
        "id": "grok-4.20-0309-non-reasoning",
        "name": "Grok 4.20 (Non-Reasoning)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 30000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      }
    }
  },
  "mistral": {
    "name": "Mistral",
    "doc": "https://docs.mistral.ai/getting-started/models/",
    "env": [
      "MISTRAL_API_KEY"
    ],
    "models": {
      "pixtral-12b": {
        "id": "pixtral-12b",
        "name": "Pixtral 12B",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-09-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.15,
          "output": 0.15
        }
      },
      "devstral-small-2507": {
        "id": "devstral-small-2507",
        "name": "Devstral Small",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "mistral-small-2506": {
        "id": "mistral-small-2506",
        "name": "Mistral Small 3.2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-06-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "magistral-small": {
        "id": "magistral-small",
        "name": "Magistral Small",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.5,
          "output": 1.5
        }
      },
      "devstral-2512": {
        "id": "devstral-2512",
        "name": "Devstral 2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "mistral-embed": {
        "id": "mistral-embed",
        "name": "Mistral Embed",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2023-12-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8000,
          "output": 3072
        },
        "cost": {
          "input": 0.1,
          "output": 0
        }
      },
      "devstral-small-2505": {
        "id": "devstral-small-2505",
        "name": "Devstral Small 2505",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-05-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "labs-devstral-small-2512": {
        "id": "labs-devstral-small-2512",
        "name": "Devstral Small 2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-09",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "magistral-medium-latest": {
        "id": "magistral-medium-latest",
        "name": "Magistral Medium (latest)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2,
          "output": 5
        }
      },
      "open-mixtral-8x22b": {
        "id": "open-mixtral-8x22b",
        "name": "Mixtral 8x22B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-04-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 64000,
          "output": 64000
        },
        "cost": {
          "input": 2,
          "output": 6
        }
      },
      "open-mixtral-8x7b": {
        "id": "open-mixtral-8x7b",
        "name": "Mixtral 8x7B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2023-12-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32000,
          "output": 32000
        },
        "cost": {
          "input": 0.7,
          "output": 0.7
        }
      },
      "open-mistral-7b": {
        "id": "open-mistral-7b",
        "name": "Mistral 7B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2023-09-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8000,
          "output": 8000
        },
        "cost": {
          "input": 0.25,
          "output": 0.25
        }
      },
      "mistral-medium-latest": {
        "id": "mistral-medium-latest",
        "name": "Mistral Medium (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-29",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 1.5,
          "output": 7.5
        }
      },
      "devstral-medium-2507": {
        "id": "devstral-medium-2507",
        "name": "Devstral Medium",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "mistral-medium-2604": {
        "id": "mistral-medium-2604",
        "name": "Mistral Medium 3.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-29",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 1.5,
          "output": 7.5
        }
      },
      "mistral-large-2512": {
        "id": "mistral-large-2512",
        "name": "Mistral Large 3",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.5,
          "output": 1.5
        }
      },
      "devstral-medium-latest": {
        "id": "devstral-medium-latest",
        "name": "Devstral 2 (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "voxtral-small-latest": {
        "id": "voxtral-small-latest",
        "name": "Voxtral Small (latest)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-15",
        "modalities": {
          "input": [
            "text",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32000,
          "output": 32000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "ministral-8b-latest": {
        "id": "ministral-8b-latest",
        "name": "Ministral 8B (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.1,
          "output": 0.1
        }
      },
      "mistral-nemo": {
        "id": "mistral-nemo",
        "name": "Mistral Nemo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.15,
          "output": 0.15
        }
      },
      "voxtral-mini-tts-latest": {
        "id": "voxtral-mini-tts-latest",
        "name": "Voxtral Mini TTS (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "mistral-small-latest": {
        "id": "mistral-small-latest",
        "name": "Mistral Small (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6
        }
      },
      "open-mistral-nemo": {
        "id": "open-mistral-nemo",
        "name": "Open Mistral Nemo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.15,
          "output": 0.15
        }
      },
      "mistral-large-latest": {
        "id": "mistral-large-latest",
        "name": "Mistral Large (latest)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.5,
          "output": 1.5
        }
      },
      "voxtral-mini-latest": {
        "id": "voxtral-mini-latest",
        "name": "Voxtral Mini (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-02-01",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "mistral-large-2411": {
        "id": "mistral-large-2411",
        "name": "Mistral Large 2.1",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 2,
          "output": 6
        }
      },
      "devstral-latest": {
        "id": "devstral-latest",
        "name": "Devstral 2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "zai-glm-5-2": {
        "id": "zai-glm-5-2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.14
        }
      },
      "mistral-small-2603": {
        "id": "mistral-small-2603",
        "name": "Mistral Small 4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6
        }
      },
      "mistral-medium-2505": {
        "id": "mistral-medium-2505",
        "name": "Mistral Medium 3",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "codestral-latest": {
        "id": "codestral-latest",
        "name": "Codestral (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 4096
        },
        "cost": {
          "input": 0.3,
          "output": 0.9
        }
      },
      "ministral-3b-latest": {
        "id": "ministral-3b-latest",
        "name": "Ministral 3B (latest)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 0.04,
          "output": 0.04
        }
      },
      "mistral-medium-2508": {
        "id": "mistral-medium-2508",
        "name": "Mistral Medium 3.1",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.4,
          "output": 2
        }
      },
      "pixtral-large-latest": {
        "id": "pixtral-large-latest",
        "name": "Pixtral Large (latest)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 6
        }
      }
    }
  },
  "groq": {
    "name": "Groq",
    "doc": "https://console.groq.com/docs/models",
    "env": [
      "GROQ_API_KEY"
    ],
    "models": {
      "whisper-large-v3": {
        "id": "whisper-large-v3",
        "name": "Whisper",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2023-09-01",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "whisper-large-v3-turbo": {
        "id": "whisper-large-v3-turbo",
        "name": "Whisper Large V3 Turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-01",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "llama-3.1-8b-instant": {
        "id": "llama-3.1-8b-instant",
        "name": "Llama 3.1 8B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.05,
          "output": 0.08
        }
      },
      "allam-2-7b": {
        "id": "allam-2-7b",
        "name": "ALLaM-2-7b",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 4096,
          "output": 4096
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "llama-3.3-70b-versatile": {
        "id": "llama-3.3-70b-versatile",
        "name": "Llama 3.3 70B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.59,
          "output": 0.79
        }
      },
      "qwen/qwen3.8-27b": {
        "id": "qwen/qwen3.8-27b",
        "name": "Qwen3.8 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131042,
          "output": 16384
        },
        "cost": {
          "input": 0.8,
          "output": 4
        }
      },
      "qwen/qwen3.6-27b": {
        "id": "qwen/qwen3.6-27b",
        "name": "Qwen3.6 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 3,
          "cache_read": 0.3
        }
      },
      "groq/compound": {
        "id": "groq/compound",
        "name": "Compound",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 8192
        }
      },
      "groq/compound-mini": {
        "id": "groq/compound-mini",
        "name": "Compound Mini",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 8192
        }
      },
      "meta-llama/llama-prompt-guard-2-86m": {
        "id": "meta-llama/llama-prompt-guard-2-86m",
        "name": "Prompt Guard 2 86M",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2025-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 512,
          "output": 512
        },
        "cost": {
          "input": 0.04,
          "output": 0.04
        }
      },
      "meta-llama/llama-prompt-guard-2-22m": {
        "id": "meta-llama/llama-prompt-guard-2-22m",
        "name": "Llama Prompt Guard 2 22M",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2025-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 512,
          "output": 512
        },
        "cost": {
          "input": 0.03,
          "output": 0.03
        }
      },
      "openai/gpt-oss-20b": {
        "id": "openai/gpt-oss-20b",
        "name": "GPT OSS 20B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.075,
          "output": 0.3,
          "cache_read": 0.0375
        }
      },
      "openai/gpt-oss-safeguard-20b": {
        "id": "openai/gpt-oss-safeguard-20b",
        "name": "Safety GPT OSS 20B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.075,
          "output": 0.3
        }
      },
      "openai/gpt-oss-120b": {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.075
        }
      },
      "canopylabs/orpheus-v1-english": {
        "id": "canopylabs/orpheus-v1-english",
        "name": "Canopy Labs Orpheus V1 English",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 4000,
          "output": 50000
        }
      },
      "canopylabs/orpheus-arabic-saudi": {
        "id": "canopylabs/orpheus-arabic-saudi",
        "name": "Canopy Labs Orpheus Arabic Saudi",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 4000,
          "output": 50000
        }
      }
    }
  },
  "cohere": {
    "name": "Cohere",
    "doc": "https://docs.cohere.com/docs/models",
    "env": [
      "COHERE_API_KEY"
    ],
    "models": {
      "command-r7b-arabic-02-2025": {
        "id": "command-r7b-arabic-02-2025",
        "name": "Command R7B Arabic",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-02-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 0.0375,
          "output": 0.15
        }
      },
      "command-a-plus-05-2026": {
        "id": "command-a-plus-05-2026",
        "name": "Command A Plus",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 64000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "command-a-reasoning-08-2025": {
        "id": "command-a-reasoning-08-2025",
        "name": "Command A Reasoning",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 32000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "command-a-vision-07-2025": {
        "id": "command-a-vision-07-2025",
        "name": "Command A Vision",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-31",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 8000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "north-mini-code-1-0": {
        "id": "north-mini-code-1-0",
        "name": "North Mini Code",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 64000
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "command-r-plus-08-2024": {
        "id": "command-r-plus-08-2024",
        "name": "Command R+",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "command-a-translate-08-2025": {
        "id": "command-a-translate-08-2025",
        "name": "Command A Translate",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8000,
          "output": 8000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "command-a-03-2025": {
        "id": "command-a-03-2025",
        "name": "Command A",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 8000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "c4ai-aya-expanse-32b": {
        "id": "c4ai-aya-expanse-32b",
        "name": "Aya Expanse 32B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        }
      },
      "c4ai-aya-expanse-8b": {
        "id": "c4ai-aya-expanse-8b",
        "name": "Aya Expanse 8B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8000,
          "output": 4000
        }
      },
      "c4ai-aya-vision-8b": {
        "id": "c4ai-aya-vision-8b",
        "name": "Aya Vision 8B",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16000,
          "output": 4000
        }
      },
      "command-r7b-12-2024": {
        "id": "command-r7b-12-2024",
        "name": "Command R7B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 0.0375,
          "output": 0.15
        }
      },
      "c4ai-aya-vision-32b": {
        "id": "c4ai-aya-vision-32b",
        "name": "Aya Vision 32B",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16000,
          "output": 4000
        }
      },
      "command-r-08-2024": {
        "id": "command-r-08-2024",
        "name": "Command R",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6
        }
      }
    }
  },
  "perplexity": {
    "name": "Perplexity",
    "doc": "https://docs.perplexity.ai",
    "env": [
      "PERPLEXITY_API_KEY"
    ],
    "models": {
      "sonar": {
        "id": "sonar",
        "name": "Sonar",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-01-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 1,
          "output": 1
        }
      },
      "sonar-reasoning-pro": {
        "id": "sonar-reasoning-pro",
        "name": "Sonar Reasoning Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-01-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 2,
          "output": 8
        }
      },
      "sonar-pro": {
        "id": "sonar-pro",
        "name": "Sonar Pro",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-01-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 8192
        },
        "cost": {
          "input": 3,
          "output": 15
        }
      },
      "sonar-deep-research": {
        "id": "sonar-deep-research",
        "name": "Perplexity Sonar Deep Research",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-02-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 8,
          "reasoning": 3
        }
      }
    }
  },
  "openrouter": {
    "name": "OpenRouter",
    "api": "https://openrouter.ai/api/v1",
    "doc": "https://openrouter.ai/models",
    "env": [
      "OPENROUTER_API_KEY"
    ],
    "models": {
      "qwen/qwen3.7-max": {
        "id": "qwen/qwen3.7-max",
        "name": "Qwen3.7 Max",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.475,
          "output": 4.425,
          "cache_read": 0.295,
          "cache_write": 1.84375
        }
      },
      "qwen/qwen3-coder-plus": {
        "id": "qwen/qwen3-coder-plus",
        "name": "Qwen3 Coder Plus",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.65,
          "output": 3.25,
          "cache_read": 0.13,
          "cache_write": 0.8125
        }
      },
      "qwen/qwen3-next-80b-a3b-thinking": {
        "id": "qwen/qwen3-next-80b-a3b-thinking",
        "name": "Qwen3-Next 80B-A3B (Thinking)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.15,
          "output": 1.2
        }
      },
      "qwen/qwen3-235b-a22b-thinking-2507": {
        "id": "qwen/qwen3-235b-a22b-thinking-2507",
        "name": "Qwen3 235B A22B Thinking 2507",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.23,
          "output": 2.3
        }
      },
      "qwen/qwen3.5-9b": {
        "id": "qwen/qwen3.5-9b",
        "name": "Qwen3.5 9B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.1,
          "output": 0.15
        }
      },
      "qwen/qwen3-next-80b-a3b-instruct": {
        "id": "qwen/qwen3-next-80b-a3b-instruct",
        "name": "Qwen3-Next 80B-A3B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 16384
        },
        "cost": {
          "input": 0.09,
          "output": 1.1
        }
      },
      "qwen/qwen3-coder-flash": {
        "id": "qwen/qwen3-coder-flash",
        "name": "Qwen3 Coder Flash",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.195,
          "output": 0.975,
          "cache_read": 0.039,
          "cache_write": 0.24375
        }
      },
      "qwen/qwen3-14b": {
        "id": "qwen/qwen3-14b",
        "name": "Qwen3 14B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.12,
          "output": 0.24
        }
      },
      "qwen/qwen3.6-plus": {
        "id": "qwen/qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.325,
          "output": 1.95,
          "cache_write": 0.40625
        }
      },
      "qwen/qwen3.5-27b": {
        "id": "qwen/qwen3.5-27b",
        "name": "Qwen3.5 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.195,
          "output": 1.56
        }
      },
      "qwen/qwen3.8-27b": {
        "id": "qwen/qwen3.8-27b",
        "name": "Qwen3.8 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.214,
          "output": 2.55,
          "cache_read": 0.15
        }
      },
      "qwen/qwen3.5-35b-a3b": {
        "id": "qwen/qwen3.5-35b-a3b",
        "name": "Qwen3.5 35B-A3B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.1625,
          "output": 1.3
        }
      },
      "qwen/qwen3.5-plus-20260420": {
        "id": "qwen/qwen3.5-plus-20260420",
        "name": "Qwen3.5 Plus 2026-04-20",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 1.8,
          "cache_write": 0.375
        }
      },
      "qwen/qwen3-32b": {
        "id": "qwen/qwen3-32b",
        "name": "Qwen3 32B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.08,
          "output": 0.28
        }
      },
      "qwen/qwen3.5-plus-02-15": {
        "id": "qwen/qwen3.5-plus-02-15",
        "name": "Qwen3.5 Plus 2026-02-15",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.26,
          "output": 1.56
        }
      },
      "qwen/qwen-plus-2025-07-28": {
        "id": "qwen/qwen-plus-2025-07-28",
        "name": "Qwen Plus 0728",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 32768
        },
        "cost": {
          "input": 0.26,
          "output": 0.78
        }
      },
      "qwen/qwen3-coder": {
        "id": "qwen/qwen3-coder",
        "name": "Qwen3 Coder 480B A35B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 1,
          "cache_read": 0.1
        }
      },
      "qwen/qwen2.5-vl-72b-instruct": {
        "id": "qwen/qwen2.5-vl-72b-instruct",
        "name": "Qwen2.5 VL 72B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-02-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 115200
        },
        "cost": {
          "input": 0.8,
          "output": 1,
          "cache_read": 0.4
        }
      },
      "qwen/qwen3-coder-next": {
        "id": "qwen/qwen3-coder-next",
        "name": "Qwen3 Coder Next",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-03",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.12,
          "output": 0.8,
          "cache_read": 0.07
        }
      },
      "qwen/qwen3-coder-30b-a3b-instruct": {
        "id": "qwen/qwen3-coder-30b-a3b-instruct",
        "name": "Qwen3-Coder 30B-A3B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.07,
          "output": 0.28
        }
      },
      "qwen/qwen3-235b-a22b-2507": {
        "id": "qwen/qwen3-235b-a22b-2507",
        "name": "Qwen3 235B A22B Instruct 2507",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.0875,
          "output": 0.35,
          "cache_read": 0.0175
        }
      },
      "qwen/qwen3.5-flash-02-23": {
        "id": "qwen/qwen3.5-flash-02-23",
        "name": "Qwen3.5-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-25",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.065,
          "output": 0.26
        }
      },
      "qwen/qwen3.5-397b-a17b": {
        "id": "qwen/qwen3.5-397b-a17b",
        "name": "Qwen3.5 397B-A17B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.55,
          "output": 3.5,
          "cache_read": 0.225
        }
      },
      "qwen/qwen3-vl-8b-thinking": {
        "id": "qwen/qwen3-vl-8b-thinking",
        "name": "Qwen3 VL 8B Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-14",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.18,
          "output": 2.1
        }
      },
      "qwen/qwen3.6-27b": {
        "id": "qwen/qwen3.6-27b",
        "name": "Qwen3.6 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 2,
          "cache_read": 0.03
        }
      },
      "qwen/qwen3.7-flash": {
        "id": "qwen/qwen3.7-flash",
        "name": "Qwen3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.03,
          "output": 0.13,
          "cache_read": 0.006,
          "cache_write": 0.038
        }
      },
      "qwen/qwen3-30b-a3b-thinking-2507": {
        "id": "qwen/qwen3-30b-a3b-thinking-2507",
        "name": "Qwen3 30B A3B Thinking 2507",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 81920,
          "output": 32768
        },
        "cost": {
          "input": 0.2,
          "output": 2.4
        }
      },
      "qwen/qwen3.6-35b-a3b": {
        "id": "qwen/qwen3.6-35b-a3b",
        "name": "Qwen3.6 35B-A3B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.1,
          "output": 0.9,
          "cache_read": 0.05
        }
      },
      "qwen/qwen3-max-thinking": {
        "id": "qwen/qwen3-max-thinking",
        "name": "Qwen3 Max Thinking",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.78,
          "output": 3.9
        }
      },
      "qwen/qwen3.8-max-0902": {
        "id": "qwen/qwen3.8-max-0902",
        "name": "Qwen3.8 Max 0902",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.25,
          "cache_write": 2.5
        }
      },
      "qwen/qwen3-max": {
        "id": "qwen/qwen3-max",
        "name": "Qwen3 Max",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.78,
          "output": 3.9,
          "cache_read": 0.156,
          "cache_write": 0.975
        }
      },
      "qwen/qwen3-vl-8b-instruct": {
        "id": "qwen/qwen3-vl-8b-instruct",
        "name": "Qwen3 VL 8B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-14",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.117,
          "output": 0.455
        }
      },
      "qwen/qwen3.8-2.4t-a95b": {
        "id": "qwen/qwen3.8-2.4t-a95b",
        "name": "Qwen3.8 2.4T A95B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.25
        }
      },
      "qwen/qwen3-vl-30b-a3b-instruct": {
        "id": "qwen/qwen3-vl-30b-a3b-instruct",
        "name": "Qwen3 VL 30B A3B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.13,
          "output": 0.52
        }
      },
      "qwen/qwen-plus": {
        "id": "qwen/qwen-plus",
        "name": "Qwen Plus",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-01-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 32768
        },
        "cost": {
          "input": 0.26,
          "output": 0.78,
          "cache_read": 0.052,
          "cache_write": 0.325
        }
      },
      "qwen/qwen3.5-122b-a10b": {
        "id": "qwen/qwen3.5-122b-a10b",
        "name": "Qwen3.5 122B-A10B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.26,
          "output": 2.08
        }
      },
      "qwen/qwen-2.5-coder-32b-instruct": {
        "id": "qwen/qwen-2.5-coder-32b-instruct",
        "name": "Qwen2.5 Coder 32B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 29491
        },
        "cost": {
          "input": 0.66,
          "output": 1
        }
      },
      "qwen/qwen3-30b-a3b-instruct-2507": {
        "id": "qwen/qwen3-30b-a3b-instruct-2507",
        "name": "Qwen3 30B A3B Instruct 2507",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32000
        },
        "cost": {
          "input": 0.04815,
          "output": 0.19305
        }
      },
      "qwen/qwen3.6-flash": {
        "id": "qwen/qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0.1875,
          "output": 1.125,
          "cache_write": 0.234375
        }
      },
      "qwen/qwen3-30b-a3b": {
        "id": "qwen/qwen3-30b-a3b",
        "name": "Qwen3 30B A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.12,
          "output": 0.5
        }
      },
      "qwen/qwen-2.5-7b-instruct": {
        "id": "qwen/qwen-2.5-7b-instruct",
        "name": "Qwen2.5 7B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 29491
        },
        "cost": {
          "input": 0.1,
          "output": 0.2
        }
      },
      "qwen/qwen3.8-flash": {
        "id": "qwen/qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.15,
          "output": 0.47,
          "cache_read": 0.016,
          "cache_write": 0.2
        }
      },
      "qwen/qwen3-vl-30b-a3b-thinking": {
        "id": "qwen/qwen3-vl-30b-a3b-thinking",
        "name": "Qwen3 VL 30B A3B Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.2,
          "output": 2.4
        }
      },
      "qwen/qwen3.6-max-preview": {
        "id": "qwen/qwen3.6-max-preview",
        "name": "Qwen3.6 Max Preview",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 1.027,
          "output": 6.162,
          "cache_write": 1.28375
        }
      },
      "qwen/qwen-2.5-72b-instruct": {
        "id": "qwen/qwen-2.5-72b-instruct",
        "name": "Qwen2.5 72B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-09-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 16384
        },
        "cost": {
          "input": 0.36,
          "output": 0.4
        }
      },
      "qwen/qwen3-8b": {
        "id": "qwen/qwen3-8b",
        "name": "Qwen3 8B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 8192
        },
        "cost": {
          "input": 0.117,
          "output": 0.455
        }
      },
      "qwen/qwen3-235b-a22b": {
        "id": "qwen/qwen3-235b-a22b",
        "name": "Qwen3 235B-A22B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 8192
        },
        "cost": {
          "input": 0.455,
          "output": 1.82
        }
      },
      "qwen/qwen3-vl-235b-a22b-thinking": {
        "id": "qwen/qwen3-vl-235b-a22b-thinking",
        "name": "Qwen3 VL 235B A22B Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-23",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.4,
          "output": 4
        }
      },
      "qwen/qwen3-vl-235b-a22b-instruct": {
        "id": "qwen/qwen3-vl-235b-a22b-instruct",
        "name": "Qwen3 VL 235B A22B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-23",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.21,
          "output": 1.9,
          "cache_read": 0.1
        }
      },
      "qwen/qwen3.7-plus": {
        "id": "qwen/qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.32,
          "output": 1.28,
          "cache_read": 0.064,
          "cache_write": 0.4
        }
      },
      "qwen/qwen3-vl-32b-instruct": {
        "id": "qwen/qwen3-vl-32b-instruct",
        "name": "Qwen3 VL 32B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-23",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.104,
          "output": 0.416
        }
      },
      "baidu/ernie-4.5-vl-424b-a47b": {
        "id": "baidu/ernie-4.5-vl-424b-a47b",
        "name": "ERNIE 4.5 VL 424B A47B ",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-06-30",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 123000,
          "output": 16000
        },
        "cost": {
          "input": 0.42,
          "output": 1.25
        }
      },
      "aion-labs/aion-2.0": {
        "id": "aion-labs/aion-2.0",
        "name": "Aion-2.0",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.8,
          "output": 1.6,
          "cache_read": 0.2
        }
      },
      "aion-labs/aion-rp-llama-3.1-8b": {
        "id": "aion-labs/aion-rp-llama-3.1-8b",
        "name": "Aion-RP 1.0 (8B)",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-02-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 29491
        },
        "cost": {
          "input": 0.8,
          "output": 1.6
        }
      },
      "aion-labs/aion-3.0": {
        "id": "aion-labs/aion-3.0",
        "name": "Aion-3.0",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 3,
          "output": 6,
          "cache_read": 0.75
        }
      },
      "aion-labs/aion-3.0-mini": {
        "id": "aion-labs/aion-3.0-mini",
        "name": "Aion-3.0-Mini",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.7,
          "output": 1.4,
          "cache_read": 0.18
        }
      },
      "~anthropic/claude-fable-latest": {
        "id": "~anthropic/claude-fable-latest",
        "name": "Claude Fable Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 0.25,
          "cache_write": 12.5
        }
      },
      "~anthropic/claude-opus-latest": {
        "id": "~anthropic/claude-opus-latest",
        "name": "Claude Opus Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "~anthropic/claude-haiku-latest": {
        "id": "~anthropic/claude-haiku-latest",
        "name": "Claude Haiku Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "~anthropic/claude-sonnet-latest": {
        "id": "~anthropic/claude-sonnet-latest",
        "name": "Claude Sonnet Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "morph/morph-v3-large": {
        "id": "morph/morph-v3-large",
        "name": "Morph V3 Large",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.9,
          "output": 1.9
        }
      },
      "morph/morph-v3-fast": {
        "id": "morph/morph-v3-fast",
        "name": "Morph V3 Fast",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 81920,
          "output": 38000
        },
        "cost": {
          "input": 0.8,
          "output": 1.2
        }
      },
      "undi95/remm-slerp-l2-13b": {
        "id": "undi95/remm-slerp-l2-13b",
        "name": "ReMM SLERP 13B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2023-07-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 6144,
          "output": 5529
        },
        "cost": {
          "input": 0.35,
          "output": 0.65
        }
      },
      "~deepseek/deepseek-v4-flash-latest": {
        "id": "~deepseek/deepseek-v4-flash-latest",
        "name": "DeepSeek V4 Flash Latest",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 393216
        },
        "cost": {
          "input": 0.03,
          "output": 0.13,
          "cache_read": 0.01
        }
      },
      "~deepseek/deepseek-pro-latest": {
        "id": "~deepseek/deepseek-pro-latest",
        "name": "DeepSeek Pro Latest",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 393216
        },
        "cost": {
          "input": 0.65868,
          "output": 1.97604,
          "cache_read": 0.020958
        }
      },
      "~deepseek/deepseek-flash-latest": {
        "id": "~deepseek/deepseek-flash-latest",
        "name": "DeepSeek Flash Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.015
        }
      },
      "dots-studio/dots-3-note-preview:free": {
        "id": "dots-studio/dots-3-note-preview:free",
        "name": "Dots3-Note Preview (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 512000,
          "output": 460800
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "~x-ai/grok-latest": {
        "id": "~x-ai/grok-latest",
        "name": "Grok Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 500000,
          "output": 450000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      "meituan/longcat-2.0": {
        "id": "meituan/longcat-2.0",
        "name": "LongCat 2.0",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048756,
          "output": 262144
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.006
        }
      },
      "poolside/laguna-xs-2.1": {
        "id": "poolside/laguna-xs-2.1",
        "name": "Laguna XS 2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.06,
          "output": 0.12,
          "cache_read": 0.03
        }
      },
      "poolside/laguna-xs-2.1:free": {
        "id": "poolside/laguna-xs-2.1:free",
        "name": "Laguna XS 2.1 (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "poolside/laguna-s-2.1:free": {
        "id": "poolside/laguna-s-2.1:free",
        "name": "Laguna S 2.1 (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "poolside/laguna-s-2.1": {
        "id": "poolside/laguna-s-2.1",
        "name": "Laguna S 2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 0.09,
          "output": 0.18,
          "cache_read": 0.009
        }
      },
      "kwaipilot/kat-coder-pro-v2": {
        "id": "kwaipilot/kat-coder-pro-v2",
        "name": "KAT-Coder-Pro V2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 144000
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      "kwaipilot/kat-coder-pro-v2.5": {
        "id": "kwaipilot/kat-coder-pro-v2.5",
        "name": "KAT-Coder-Pro V2.5",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.74,
          "output": 2.96,
          "cache_read": 0.15
        }
      },
      "stepfun/step-3.7-flash": {
        "id": "stepfun/step-3.7-flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 230400
        },
        "cost": {
          "input": 0.2,
          "output": 1.15,
          "cache_read": 0.04
        }
      },
      "stepfun/step-3.5-flash": {
        "id": "stepfun/step-3.5-flash",
        "name": "Step 3.5 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "mistralai/ministral-14b-2512": {
        "id": "mistralai/ministral-14b-2512",
        "name": "Ministral 3 14B 2512",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 0.2,
          "output": 0.2,
          "cache_read": 0.02
        }
      },
      "mistralai/mistral-large": {
        "id": "mistralai/mistral-large",
        "name": "Mistral Large",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-02-26",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 102400
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.2
        }
      },
      "mistralai/codestral-2508": {
        "id": "mistralai/codestral-2508",
        "name": "Codestral 2508",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-01",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 204800
        },
        "cost": {
          "input": 0.3,
          "output": 0.9,
          "cache_read": 0.03
        }
      },
      "mistralai/mistral-medium-3-5": {
        "id": "mistralai/mistral-medium-3-5",
        "name": "Mistral Medium 3.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 1.5,
          "output": 7.5
        }
      },
      "mistralai/devstral-2512": {
        "id": "mistralai/devstral-2512",
        "name": "Devstral 2",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-09",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 0.4,
          "output": 2,
          "cache_read": 0.04
        }
      },
      "mistralai/mistral-large-2407": {
        "id": "mistralai/mistral-large-2407",
        "name": "Mistral Large 2407",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-11-19",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 104857
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.2
        }
      },
      "mistralai/mistral-small-3.2-24b-instruct": {
        "id": "mistralai/mistral-small-3.2-24b-instruct",
        "name": "Mistral Small 3.2 24B",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-06-20",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 16384
        },
        "cost": {
          "input": 0.09375,
          "output": 0.25
        }
      },
      "mistralai/mixtral-8x22b-instruct": {
        "id": "mistralai/mixtral-8x22b-instruct",
        "name": "Mixtral 8x22B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-04-17",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 52428
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.2
        }
      },
      "mistralai/mistral-saba": {
        "id": "mistralai/mistral-saba",
        "name": "Saba",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-02-17",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 26214
        },
        "cost": {
          "input": 0.2,
          "output": 0.6,
          "cache_read": 0.02
        }
      },
      "mistralai/mistral-large-2512": {
        "id": "mistralai/mistral-large-2512",
        "name": "Mistral Large 3",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 0.5,
          "output": 1.5,
          "cache_read": 0.05
        }
      },
      "mistralai/ministral-3b-2512": {
        "id": "mistralai/ministral-3b-2512",
        "name": "Ministral 3 3B 2512",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 104857
        },
        "cost": {
          "input": 0.1,
          "output": 0.1,
          "cache_read": 0.01
        }
      },
      "mistralai/mistral-nemo": {
        "id": "mistralai/mistral-nemo",
        "name": "Mistral Nemo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.019,
          "output": 0.03
        }
      },
      "mistralai/mistral-medium-3": {
        "id": "mistralai/mistral-medium-3",
        "name": "Mistral Medium 3",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 104857
        },
        "cost": {
          "input": 0.4,
          "output": 2,
          "cache_read": 0.04
        }
      },
      "mistralai/mistral-small-24b-instruct-2501": {
        "id": "mistralai/mistral-small-24b-instruct-2501",
        "name": "Mistral Small 3",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 16384
        },
        "cost": {
          "input": 0.05,
          "output": 0.08
        }
      },
      "mistralai/mistral-small-3.1-24b-instruct": {
        "id": "mistralai/mistral-small-3.1-24b-instruct",
        "name": "Mistral Small 3.1 24B",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-17",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 102400
        },
        "cost": {
          "input": 0.351,
          "output": 0.555
        }
      },
      "mistralai/mistral-small-2603": {
        "id": "mistralai/mistral-small-2603",
        "name": "Mistral Small 4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.015
        }
      },
      "mistralai/ministral-8b-2512": {
        "id": "mistralai/ministral-8b-2512",
        "name": "Ministral 3 8B 2512",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 209715
        },
        "cost": {
          "input": 0.15,
          "output": 0.15,
          "cache_read": 0.015
        }
      },
      "mistralai/voxtral-small-24b-2507": {
        "id": "mistralai/voxtral-small-24b-2507",
        "name": "Voxtral Small 24B 2507",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-15",
        "modalities": {
          "input": [
            "text",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 26214
        },
        "cost": {
          "input": 0.1,
          "output": 0.3,
          "cache_read": 0.01
        }
      },
      "mistralai/mistral-medium-3.1": {
        "id": "mistralai/mistral-medium-3.1",
        "name": "Mistral Medium 3.1",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 104857
        },
        "cost": {
          "input": 0.4,
          "output": 2,
          "cache_read": 0.04
        }
      },
      "xiaomi/mimo-v2.5": {
        "id": "xiaomi/mimo-v2.5",
        "name": "MiMo-V2.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 131072
        },
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.0028
        }
      },
      "xiaomi/mimo-v2.5-pro": {
        "id": "xiaomi/mimo-v2.5-pro",
        "name": "MiMo-V2.5-Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 131072
        },
        "cost": {
          "input": 0.435,
          "output": 0.87,
          "cache_read": 0.0036
        }
      },
      "minimax/minimax-m2.1": {
        "id": "minimax/minimax-m2.1",
        "name": "MiniMax-M2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03
        }
      },
      "minimax/minimax-m2": {
        "id": "minimax/minimax-m2",
        "name": "MiniMax-M2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.255,
          "output": 1.02
        }
      },
      "minimax/minimax-m2.7": {
        "id": "minimax/minimax-m2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      "minimax/minimax-m2.5": {
        "id": "minimax/minimax-m2.5",
        "name": "MiniMax-M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 128000
        },
        "cost": {
          "input": 0.27,
          "output": 1.08,
          "cache_read": 0.027
        }
      },
      "minimax/minimax-m3": {
        "id": "minimax/minimax-m3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      "minimax/minimax-m2-her": {
        "id": "minimax/minimax-m2-her",
        "name": "MiniMax-M2 Her",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-01-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 2048
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03
        }
      },
      "minimax/minimax-m1": {
        "id": "minimax/minimax-m1",
        "name": "MiniMax M1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 40000
        },
        "cost": {
          "input": 0.4,
          "output": 2.2
        }
      },
      "minimax/minimax-01": {
        "id": "minimax/minimax-01",
        "name": "MiniMax-01",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000192,
          "output": 900172
        },
        "cost": {
          "input": 0.2,
          "output": 1.1
        }
      },
      "nvidia/nemotron-3.5-lightning:free": {
        "id": "nvidia/nemotron-3.5-lightning:free",
        "name": "Nemotron 3.5 Lightning (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3.5-content-safety": {
        "id": "nvidia/nemotron-3.5-content-safety",
        "name": "Nemotron 3.5 Content Safety",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.2,
          "output": 0.2
        }
      },
      "nvidia/nemotron-3.5-lightning": {
        "id": "nvidia/nemotron-3.5-lightning",
        "name": "Nemotron 3.5 Lightning 30B A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.08,
          "output": 0.2,
          "cache_read": 0.04
        }
      },
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
        "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "name": "Nemotron 3 Nano Omni (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3-super-120b-a12b": {
        "id": "nvidia/nemotron-3-super-120b-a12b",
        "name": "Nemotron 3 Super 120B A12B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.08,
          "output": 0.45
        }
      },
      "nvidia/nemotron-3-ultra-550b-a55b:free": {
        "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
        "name": "Nemotron 3 Ultra (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3-super-120b-a12b:free": {
        "id": "nvidia/nemotron-3-super-120b-a12b:free",
        "name": "Nemotron 3 Super (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3.5-content-safety:free": {
        "id": "nvidia/nemotron-3.5-content-safety:free",
        "name": "Nemotron 3.5 Content Safety (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 8192
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3-ultra-550b-a55b": {
        "id": "nvidia/nemotron-3-ultra-550b-a55b",
        "name": "Nemotron 3 Ultra 550B A55B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.625,
          "output": 3.125,
          "cache_read": 0.1875
        }
      },
      "nvidia/nemotron-3-nano-30b-a3b": {
        "id": "nvidia/nemotron-3-nano-30b-a3b",
        "name": "Nemotron 3 Nano 30B A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.06,
          "output": 0.24
        }
      },
      "anthropic/claude-opus-4.8": {
        "id": "anthropic/claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "anthropic/claude-opus-4.7": {
        "id": "anthropic/claude-opus-4.7",
        "name": "Claude Opus 4.7",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "anthropic/claude-opus-5": {
        "id": "anthropic/claude-opus-5",
        "name": "Claude Opus 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-24",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "anthropic/claude-opus-4.1": {
        "id": "anthropic/claude-opus-4.1",
        "name": "Claude Opus 4.1 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 32000
        },
        "cost": {
          "input": 15,
          "output": 75,
          "cache_read": 1.5,
          "cache_write": 18.75
        }
      },
      "anthropic/claude-sonnet-4.6": {
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "anthropic/claude-3-haiku": {
        "id": "anthropic/claude-3-haiku",
        "name": "Claude 3 Haiku",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-03-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 4096
        },
        "cost": {
          "input": 0.25,
          "output": 1.25,
          "cache_read": 0.03,
          "cache_write": 0.3
        }
      },
      "anthropic/claude-haiku-4.5": {
        "id": "anthropic/claude-haiku-4.5",
        "name": "Claude Haiku 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "anthropic/claude-opus-4.6": {
        "id": "anthropic/claude-opus-4.6",
        "name": "Claude Opus 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "anthropic/claude-fable-5": {
        "id": "anthropic/claude-fable-5",
        "name": "Claude Fable 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "anthropic/claude-opus-4": {
        "id": "anthropic/claude-opus-4",
        "name": "Claude Opus 4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-22",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 32000
        },
        "cost": {
          "input": 15,
          "output": 75,
          "cache_read": 1.5,
          "cache_write": 18.75
        }
      },
      "anthropic/claude-sonnet-4.5": {
        "id": "anthropic/claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 64000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "anthropic/claude-opus-4.5": {
        "id": "anthropic/claude-opus-4.5",
        "name": "Claude Opus 4.5 (latest)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-24",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      "anthropic/claude-sonnet-4": {
        "id": "anthropic/claude-sonnet-4",
        "name": "Claude Sonnet 4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-22",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 64000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      "anthropic/claude-sonnet-5": {
        "id": "anthropic/claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "anthropic/claude-fable-5.1": {
        "id": "anthropic/claude-fable-5.1",
        "name": "Claude Fable 5.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 0.25,
          "cache_write": 12.5
        }
      },
      "google/gemma-4-26b-a4b-it": {
        "id": "google/gemma-4-26b-a4b-it",
        "name": "Gemma 4 26B A4B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.09,
          "output": 0.3,
          "cache_read": 0.05
        }
      },
      "google/gemini-3.1-pro-preview-customtools": {
        "id": "google/gemini-3.1-pro-preview-customtools",
        "name": "Gemini 3.1 Pro Preview Custom Tools",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "reasoning": 12,
          "cache_read": 0.2,
          "cache_write": 0.375
        }
      },
      "google/gemini-3.1-flash-lite-image": {
        "id": "google/gemini-3.1-flash-lite-image",
        "name": "Nano Banana 2 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-30",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 58982
        },
        "cost": {
          "input": 0.25,
          "output": 1.5
        }
      },
      "google/gemma-3-4b-it": {
        "id": "google/gemma-3-4b-it",
        "name": "Gemma 3 4B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.05,
          "output": 0.1
        }
      },
      "google/lyria-3-clip-preview": {
        "id": "google/lyria-3-clip-preview",
        "name": "Lyria 3 Clip Preview",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "google/gemini-2.5-flash-image": {
        "id": "google/gemini-2.5-flash-image",
        "name": "Nano Banana",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-26",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 8192
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "cache_read": 0.03,
          "cache_write": 0.083333
        }
      },
      "google/gemini-3-pro-image": {
        "id": "google/gemini-3-pro-image",
        "name": "Nano Banana Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 12,
          "reasoning": 12,
          "cache_read": 0.2,
          "cache_write": 0.375
        }
      },
      "google/gemini-3.1-pro-preview": {
        "id": "google/gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "reasoning": 12,
          "cache_read": 0.2,
          "cache_write": 0.375
        }
      },
      "google/gemini-2.5-flash-lite": {
        "id": "google/gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash-Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65535
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "reasoning": 0.4,
          "cache_read": 0.01,
          "cache_write": 0.083333
        }
      },
      "google/gemini-3.6-flash": {
        "id": "google/gemini-3.6-flash",
        "name": "Gemini 3.6 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "reasoning": 3.75,
          "cache_read": 0.075,
          "cache_write": 0.041667
        }
      },
      "google/gemini-3.1-flash-lite": {
        "id": "google/gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 1.5,
          "reasoning": 1.5,
          "cache_read": 0.025,
          "cache_write": 0.083333
        }
      },
      "google/gemini-3.5-flash": {
        "id": "google/gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 1.5,
          "output": 9,
          "reasoning": 9,
          "cache_read": 0.15,
          "cache_write": 0.083333
        }
      },
      "google/gemini-3.1-flash-lite-preview": {
        "id": "google/gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 1.5,
          "reasoning": 1.5,
          "cache_read": 0.025,
          "cache_write": 0.083333
        }
      },
      "google/gemma-3-27b-it": {
        "id": "google/gemma-3-27b-it",
        "name": "Gemma 3 27B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.08,
          "output": 0.45,
          "cache_read": 0.04
        }
      },
      "google/gemini-3.1-flash-image": {
        "id": "google/gemini-3.1-flash-image",
        "name": "Nano Banana 2",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-28",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.5,
          "output": 3
        }
      },
      "google/gemini-3.5-flash-lite": {
        "id": "google/gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "reasoning": 2.5,
          "cache_read": 0.03,
          "cache_write": 0.083333
        }
      },
      "google/gemini-2.5-pro-preview": {
        "id": "google/gemini-2.5-pro-preview",
        "name": "Gemini 2.5 Pro Preview 06-05",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-05",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "reasoning": 10,
          "cache_read": 0.125,
          "cache_write": 0.375
        }
      },
      "google/gemini-3-pro-image-preview": {
        "id": "google/gemini-3-pro-image-preview",
        "name": "Nano Banana Pro Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-11-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 12,
          "reasoning": 12,
          "cache_read": 0.2,
          "cache_write": 0.375
        }
      },
      "google/gemma-4-31b-it:free": {
        "id": "google/gemma-4-31b-it:free",
        "name": "Gemma 4 31B (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "google/gemma-4-31b-it": {
        "id": "google/gemma-4-31b-it",
        "name": "Gemma 4 31B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 16384
        },
        "cost": {
          "input": 0.09,
          "output": 0.34,
          "cache_read": 0.05
        }
      },
      "google/gemini-3-flash-preview": {
        "id": "google/gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.5,
          "output": 3,
          "reasoning": 3,
          "cache_read": 0.05,
          "cache_write": 0.083333
        }
      },
      "google/gemini-3.8-flash": {
        "id": "google/gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "reasoning": 3.75,
          "cache_read": 0.075,
          "cache_write": 0.041667
        }
      },
      "google/lyria-3-pro-preview": {
        "id": "google/lyria-3-pro-preview",
        "name": "Lyria 3 Pro Preview",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "google/gemini-3.7-flash": {
        "id": "google/gemini-3.7-flash",
        "name": "Gemini 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "reasoning": 3.75,
          "cache_read": 0.075,
          "cache_write": 0.041667
        }
      },
      "google/gemini-2.5-pro": {
        "id": "google/gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "reasoning": 10,
          "cache_read": 0.125,
          "cache_write": 0.375
        }
      },
      "google/gemini-3.1-flash-image-preview": {
        "id": "google/gemini-3.1-flash-image-preview",
        "name": "Nano Banana 2 Preview",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-26",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 58982
        },
        "cost": {
          "input": 0.5,
          "output": 3
        }
      },
      "google/gemini-2.5-flash": {
        "id": "google/gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65535
        },
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "reasoning": 2.5,
          "cache_read": 0.03,
          "cache_write": 0.083333
        }
      },
      "google/gemma-3-12b-it": {
        "id": "google/gemma-3-12b-it",
        "name": "Gemma 3 12B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.05,
          "output": 0.15
        }
      },
      "google/gemma-4-26b-a4b-it:free": {
        "id": "google/gemma-4-26b-a4b-it:free",
        "name": "Gemma 4 26B A4B  (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "google/gemma-2-27b-it": {
        "id": "google/gemma-2-27b-it",
        "name": "Gemma 2 27B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 2048
        },
        "cost": {
          "input": 0.65,
          "output": 0.65
        }
      },
      "relace/relace-apply-3": {
        "id": "relace/relace-apply-3",
        "name": "Relace Apply 3",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-09-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 128000
        },
        "cost": {
          "input": 0.85,
          "output": 1.25
        }
      },
      "relace/relace-search": {
        "id": "relace/relace-search",
        "name": "Relace Search",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 128000
        },
        "cost": {
          "input": 1,
          "output": 3
        }
      },
      "nex-agi/nex-n2.5-mini:free": {
        "id": "nex-agi/nex-n2.5-mini:free",
        "name": "Nex-N2.5-Mini (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-08",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nex-agi/nex-n2.5-pro:free": {
        "id": "nex-agi/nex-n2.5-pro:free",
        "name": "Nex-N2.5-Pro (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-08",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "thinkingmachines/inkling-small": {
        "id": "thinkingmachines/inkling-small",
        "name": "Inkling Small",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 262144
        },
        "cost": {
          "input": 0.45,
          "output": 1.2,
          "cache_read": 0.1
        }
      },
      "thinkingmachines/inkling-small:free": {
        "id": "thinkingmachines/inkling-small:free",
        "name": "Inkling Small (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 262144
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "thinkingmachines/inkling:free": {
        "id": "thinkingmachines/inkling:free",
        "name": "Inkling (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 262144
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "thinkingmachines/inkling": {
        "id": "thinkingmachines/inkling",
        "name": "Inkling",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 471859
        },
        "cost": {
          "input": 1,
          "output": 4.05,
          "cache_read": 0.17
        }
      },
      "gryphe/mythomax-l2-13b": {
        "id": "gryphe/mythomax-l2-13b",
        "name": "MythoMax 13B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2023-07-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 3686
        },
        "cost": {
          "input": 0.08,
          "output": 0.11
        }
      },
      "meta/muse-spark-1.3": {
        "id": "meta/muse-spark-1.3",
        "name": "Muse Spark 1.3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 1.25,
          "output": 4.25,
          "cache_read": 0.15
        }
      },
      "meta/muse-spark-1.2": {
        "id": "meta/muse-spark-1.2",
        "name": "Muse Spark 1.2",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 1.25,
          "output": 4.25,
          "cache_read": 0.15
        }
      },
      "meta/muse-spark-1.2-contributor": {
        "id": "meta/muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 0.1,
          "output": 0.2,
          "cache_read": 0.002
        }
      },
      "meta/muse-spark-1.3-contributor": {
        "id": "meta/muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 0.1,
          "output": 0.2,
          "cache_read": 0.002
        }
      },
      "meta/muse-spark-1.1": {
        "id": "meta/muse-spark-1.1",
        "name": "Muse Spark 1.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 1.25,
          "output": 4.25,
          "cache_read": 0.15
        }
      },
      "meta/muse-glimmer-30b": {
        "id": "meta/muse-glimmer-30b",
        "name": "Muse Glimmer 30B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.3,
          "output": 1.1,
          "cache_read": 0.04
        }
      },
      "perceptron/perceptron-mk1": {
        "id": "perceptron/perceptron-mk1",
        "name": "Perceptron Mk1",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 8192
        },
        "cost": {
          "input": 0.15,
          "output": 1.5
        }
      },
      "thedrummer/skyfall-36b-v2": {
        "id": "thedrummer/skyfall-36b-v2",
        "name": "Skyfall 36B V2",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 29491
        },
        "cost": {
          "input": 0.55,
          "output": 0.8,
          "cache_read": 0.25
        }
      },
      "thedrummer/unslopnemo-12b": {
        "id": "thedrummer/unslopnemo-12b",
        "name": "UnslopNemo 12B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-11-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1024000,
          "output": 819200
        },
        "cost": {
          "input": 0.4,
          "output": 0.4
        }
      },
      "thedrummer/cydonia-24b-v4.1": {
        "id": "thedrummer/cydonia-24b-v4.1",
        "name": "Cydonia 24B V4.1",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.3,
          "output": 0.5,
          "cache_read": 0.15
        }
      },
      "bytedance/ui-tars-1.5-7b": {
        "id": "bytedance/ui-tars-1.5-7b",
        "name": "UI-TARS 7B ",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-22",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 2048
        },
        "cost": {
          "input": 0.1,
          "output": 0.2,
          "cache_read": 0.1
        }
      },
      "bytedance-seed/seed-1.6-flash": {
        "id": "bytedance-seed/seed-1.6-flash",
        "name": "Seed 1.6 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.075,
          "output": 0.3
        }
      },
      "bytedance-seed/seed-2-1-turbo": {
        "id": "bytedance-seed/seed-2-1-turbo",
        "name": "Seed 2.1 Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.5,
          "output": 2.5
        }
      },
      "bytedance-seed/seed-2.0-code": {
        "id": "bytedance-seed/seed-2.0-code",
        "name": "Seed 2.0 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.5,
          "output": 3
        }
      },
      "bytedance-seed/seed-1.6": {
        "id": "bytedance-seed/seed-1.6",
        "name": "Seed 1.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.25,
          "output": 2
        }
      },
      "bytedance-seed/seed-2.0-mini": {
        "id": "bytedance-seed/seed-2.0-mini",
        "name": "Seed 2.0 Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.1,
          "output": 0.4
        }
      },
      "bytedance-seed/seed-2.0-lite": {
        "id": "bytedance-seed/seed-2.0-lite",
        "name": "Seed 2.0 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.25,
          "output": 2
        }
      },
      "inception/mercury-2.5": {
        "id": "inception/mercury-2.5",
        "name": "Mercury 2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 260000,
          "output": 65536
        },
        "cost": {
          "input": 0.04,
          "output": 0.15,
          "cache_read": 0.004
        }
      },
      "inception/mercury-2": {
        "id": "inception/mercury-2",
        "name": "Mercury 2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 50000
        },
        "cost": {
          "input": 0.25,
          "output": 0.75,
          "cache_read": 0.025
        }
      },
      "writer/palmyra-x5": {
        "id": "writer/palmyra-x5",
        "name": "Palmyra X5",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-01-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1040000,
          "output": 8192
        },
        "cost": {
          "input": 0.6,
          "output": 6
        }
      },
      "~google/gemini-pro-latest": {
        "id": "~google/gemini-pro-latest",
        "name": "Gemini Pro Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "audio",
            "pdf",
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 2,
          "output": 12,
          "reasoning": 12,
          "cache_read": 0.2,
          "cache_write": 0.375
        }
      },
      "~google/gemini-flash-latest": {
        "id": "~google/gemini-flash-latest",
        "name": "Gemini Flash Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.75,
          "output": 3.75,
          "reasoning": 3.75,
          "cache_read": 0.075,
          "cache_write": 0.041667
        }
      },
      "microsoft/phi-4": {
        "id": "microsoft/phi-4",
        "name": "Phi 4",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 14745
        },
        "cost": {
          "input": 0.07,
          "output": 0.14
        }
      },
      "microsoft/wizardlm-2-8x22b": {
        "id": "microsoft/wizardlm-2-8x22b",
        "name": "WizardLM-2 8x22B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-04-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65535,
          "output": 8000
        },
        "cost": {
          "input": 0.62,
          "output": 0.62
        }
      },
      "sakana/fugu-ultra": {
        "id": "sakana/fugu-ultra",
        "name": "Fugu Ultra",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      "sakana/fugu-max": {
        "id": "sakana/fugu-max",
        "name": "Fugu Max",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.25
        }
      },
      "sakana/sakana-namazu": {
        "id": "sakana/sakana-namazu",
        "name": "Sakana Namazu",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-08-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.15
        }
      },
      "sakana/fugu-ultra-v2": {
        "id": "sakana/fugu-ultra-v2",
        "name": "Fugu Ultra v2",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      "~moonshotai/kimi-latest": {
        "id": "~moonshotai/kimi-latest",
        "name": "Kimi Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 2.1,
          "output": 10.95,
          "cache_read": 0.23
        }
      },
      "ibm-granite/granite-4.2-8b": {
        "id": "ibm-granite/granite-4.2-8b",
        "name": "Granite 4.2 8B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.06,
          "output": 0.25,
          "cache_read": 0.015
        }
      },
      "ibm-granite/granite-4.0-h-micro": {
        "id": "ibm-granite/granite-4.0-h-micro",
        "name": "Granite 4.0 Micro",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 117900
        },
        "cost": {
          "input": 0.017,
          "output": 0.112
        }
      },
      "deepseek/deepseek-chat-v3.1": {
        "id": "deepseek/deepseek-chat-v3.1",
        "name": "DeepSeek V3.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 32768
        },
        "cost": {
          "input": 0.25,
          "output": 0.95,
          "cache_read": 0.13
        }
      },
      "deepseek/deepseek-v4-flash-vision-exp": {
        "id": "deepseek/deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 0.22,
          "output": 0.66,
          "cache_read": 0.007
        }
      },
      "deepseek/deepseek-v4-pro-0813": {
        "id": "deepseek/deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 393216
        },
        "cost": {
          "input": 0.65868,
          "output": 1.97604,
          "cache_read": 0.020958
        }
      },
      "deepseek/deepseek-v4-flash-0731": {
        "id": "deepseek/deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 943718
        },
        "cost": {
          "input": 0.06,
          "output": 0.12,
          "cache_read": 0.012
        }
      },
      "deepseek/deepseek-v4-flash": {
        "id": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 0.07,
          "output": 0.14,
          "cache_read": 0.014
        }
      },
      "deepseek/deepseek-v4.1-flash": {
        "id": "deepseek/deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.003
        }
      },
      "deepseek/deepseek-r1": {
        "id": "deepseek/deepseek-r1",
        "name": "DeepSeek-R1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 64000,
          "output": 16000
        },
        "cost": {
          "input": 0.7,
          "output": 2.5
        }
      },
      "deepseek/deepseek-chat": {
        "id": "deepseek/deepseek-chat",
        "name": "DeepSeek Chat",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 16000
        },
        "cost": {
          "input": 0.2574,
          "output": 1.0287
        }
      },
      "deepseek/deepseek-r1-0528": {
        "id": "deepseek/deepseek-r1-0528",
        "name": "R1 0528",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-05-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 32768
        },
        "cost": {
          "input": 0.5,
          "output": 2.15,
          "cache_read": 0.35
        }
      },
      "deepseek/deepseek-v3.2": {
        "id": "deepseek/deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 65536
        },
        "cost": {
          "input": 0.269,
          "output": 0.4,
          "cache_read": 0.1345
        }
      },
      "deepseek/deepseek-r1-distill-llama-70b": {
        "id": "deepseek/deepseek-r1-distill-llama-70b",
        "name": "R1 Distill Llama 70B",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-01-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 7372
        },
        "cost": {
          "input": 0.8,
          "output": 0.8
        }
      },
      "deepseek/deepseek-v3.2-exp": {
        "id": "deepseek/deepseek-v3.2-exp",
        "name": "DeepSeek V3.2 Exp",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 65536
        },
        "cost": {
          "input": 0.27,
          "output": 0.41
        }
      },
      "deepseek/deepseek-v3.1-terminus": {
        "id": "deepseek/deepseek-v3.1-terminus",
        "name": "DeepSeek V3.1 Terminus",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 32768
        },
        "cost": {
          "input": 0.27,
          "output": 1,
          "cache_read": 0.135
        }
      },
      "deepseek/deepseek-v4-pro": {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 393216
        },
        "cost": {
          "input": 1.6,
          "output": 3.2,
          "cache_read": 0.135
        }
      },
      "deepseek/deepseek-chat-v3-0324": {
        "id": "deepseek/deepseek-chat-v3-0324",
        "name": "DeepSeek V3 0324",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 147456
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "~openai/gpt-terra-latest": {
        "id": "~openai/gpt-terra-latest",
        "name": "GPT Terra Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "~openai/gpt-sol-latest": {
        "id": "~openai/gpt-sol-latest",
        "name": "GPT Sol Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "~openai/gpt-luna-latest": {
        "id": "~openai/gpt-luna-latest",
        "name": "GPT Luna Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      "~openai/gpt-astra-latest": {
        "id": "~openai/gpt-astra-latest",
        "name": "GPT Astra Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "~openai/gpt-mini-latest": {
        "id": "~openai/gpt-mini-latest",
        "name": "GPT Mini Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-27",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.75,
          "output": 4.5,
          "cache_read": 0.075
        }
      },
      "amazon/nova-2-lite-v1": {
        "id": "amazon/nova-2-lite-v1",
        "name": "Nova 2 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65535
        },
        "cost": {
          "input": 0.3,
          "output": 2.5
        }
      },
      "amazon/nova-micro-v1": {
        "id": "amazon/nova-micro-v1",
        "name": "Nova Micro 1.0",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 5120
        },
        "cost": {
          "input": 0.035,
          "output": 0.14
        }
      },
      "amazon/nova-pro-v1": {
        "id": "amazon/nova-pro-v1",
        "name": "Nova Pro 1.0",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 300000,
          "output": 5120
        },
        "cost": {
          "input": 0.8,
          "output": 3.2
        }
      },
      "amazon/nova-premier-v1": {
        "id": "amazon/nova-premier-v1",
        "name": "Nova Premier 1.0",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-31",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 32000
        },
        "cost": {
          "input": 2.5,
          "output": 12.5,
          "cache_read": 0.625
        }
      },
      "amazon/nova-lite-v1": {
        "id": "amazon/nova-lite-v1",
        "name": "Nova Lite 1.0",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 300000,
          "output": 5120
        },
        "cost": {
          "input": 0.06,
          "output": 0.24
        }
      },
      "inclusionai/ling-3.0-flash": {
        "id": "inclusionai/ling-3.0-flash",
        "name": "Ling 3.0 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.021,
          "output": 0.063,
          "cache_read": 0.0042
        }
      },
      "inclusionai/ling-3.0-flash-fin": {
        "id": "inclusionai/ling-3.0-flash-fin",
        "name": "Ling 3.0 Flash Fin",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.06,
          "output": 0.18,
          "cache_read": 0.012
        }
      },
      "inclusionai/ling-3.0-flash-fin:free": {
        "id": "inclusionai/ling-3.0-flash-fin:free",
        "name": "Ling 3.0 Flash Fin (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "inclusionai/ling-3.0-flash-sante:free": {
        "id": "inclusionai/ling-3.0-flash-sante:free",
        "name": "Ling 3.0 Flash Sante (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "inclusionai/ling-3.0-flash-vl:free": {
        "id": "inclusionai/ling-3.0-flash-vl:free",
        "name": "Ling 3.0 Flash VL (free)",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "inclusionai/ling-3.0-flash-vl": {
        "id": "inclusionai/ling-3.0-flash-vl",
        "name": "Ling 3.0 Flash VL",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.06,
          "output": 0.18,
          "cache_read": 0.012
        }
      },
      "anthracite-org/magnum-v4-72b": {
        "id": "anthracite-org/magnum-v4-72b",
        "name": "Magnum v4 72B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-10-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 4096
        },
        "cost": {
          "input": 2.5,
          "output": 5
        }
      },
      "mancer/weaver": {
        "id": "mancer/weaver",
        "name": "Weaver (alpha)",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-08-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8000,
          "output": 6000
        },
        "cost": {
          "input": 0.4,
          "output": 0.75
        }
      },
      "openrouter/free": {
        "id": "openrouter/free",
        "name": "Free Models Router",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 8000
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "openrouter/pareto-code": {
        "id": "openrouter/pareto-code",
        "name": "Pareto Code Router",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 2000000,
          "output": 200000
        }
      },
      "openrouter/bodybuilder": {
        "id": "openrouter/bodybuilder",
        "name": "Body Builder (beta)",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 128000
        }
      },
      "openrouter/fusion": {
        "id": "openrouter/fusion",
        "name": "Fusion",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        }
      },
      "openrouter/auto": {
        "id": "openrouter/auto",
        "name": "Auto Router",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-11-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "pdf",
            "video"
          ],
          "output": [
            "text",
            "image"
          ]
        },
        "limit": {
          "context": 2000000,
          "output": 2000000
        }
      },
      "sao10k/l3.3-euryale-70b": {
        "id": "sao10k/l3.3-euryale-70b",
        "name": "Llama 3.3 Euryale 70B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.65,
          "output": 0.75
        }
      },
      "sao10k/l3-lunaris-8b": {
        "id": "sao10k/l3-lunaris-8b",
        "name": "Llama 3 8B Lunaris",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 7372
        },
        "cost": {
          "input": 0.04,
          "output": 0.05
        }
      },
      "sao10k/l3.1-euryale-70b": {
        "id": "sao10k/l3.1-euryale-70b",
        "name": "Llama 3.1 Euryale 70B v2.2",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.85,
          "output": 0.85
        }
      },
      "x-ai/grok-4.20-multi-agent": {
        "id": "x-ai/grok-4.20-multi-agent",
        "name": "Grok 4.20 Multi-Agent",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-31",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 2000000,
          "output": 1800000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "x-ai/grok-4.3": {
        "id": "x-ai/grok-4.3",
        "name": "Grok 4.3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 900000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "x-ai/grok-4.20": {
        "id": "x-ai/grok-4.20",
        "name": "Grok 4.20",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-31",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 2000000,
          "output": 1800000
        },
        "cost": {
          "input": 1.25,
          "output": 2.5,
          "cache_read": 0.2
        }
      },
      "x-ai/grok-4.5": {
        "id": "x-ai/grok-4.5",
        "name": "Grok 4.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-07-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 500000,
          "output": 450000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.3
        }
      },
      "x-ai/grok-build-0.1": {
        "id": "x-ai/grok-build-0.1",
        "name": "Grok Build 0.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 230400
        },
        "cost": {
          "input": 1,
          "output": 2,
          "cache_read": 0.2
        }
      },
      "x-ai/grok-4.6": {
        "id": "x-ai/grok-4.6",
        "name": "Grok 4.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 500000,
          "output": 450000
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      "meta-llama/llama-3.1-8b-instruct": {
        "id": "meta-llama/llama-3.1-8b-instruct",
        "name": "Llama-3.1-8B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.05,
          "output": 0.08,
          "cache_read": 0.025
        }
      },
      "meta-llama/llama-guard-4-12b": {
        "id": "meta-llama/llama-guard-4-12b",
        "name": "Llama Guard 4 12B",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 16384
        },
        "cost": {
          "input": 0.18,
          "output": 0.18
        }
      },
      "meta-llama/llama-3.2-3b-instruct": {
        "id": "meta-llama/llama-3.2-3b-instruct",
        "name": "Llama 3.2 3B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-09-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.05,
          "output": 0.33
        }
      },
      "meta-llama/llama-3.2-1b-instruct": {
        "id": "meta-llama/llama-3.2-1b-instruct",
        "name": "Llama 3.2 1B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-09-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 60000,
          "output": 54000
        },
        "cost": {
          "input": 0.027,
          "output": 0.201
        }
      },
      "meta-llama/llama-4-maverick": {
        "id": "meta-llama/llama-4-maverick",
        "name": "Llama 4 Maverick",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 16384
        },
        "cost": {
          "input": 0.1875,
          "output": 0.6525
        }
      },
      "meta-llama/llama-4-scout": {
        "id": "meta-llama/llama-4-scout",
        "name": "Llama 4 Scout",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 16384
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "meta-llama/llama-3.1-70b-instruct": {
        "id": "meta-llama/llama-3.1-70b-instruct",
        "name": "Llama-3.1-70B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.4,
          "output": 0.4
        }
      },
      "meta-llama/llama-3.3-70b-instruct": {
        "id": "meta-llama/llama-3.3-70b-instruct",
        "name": "Llama-3.3-70B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.1,
          "output": 0.32
        }
      },
      "nousresearch/hermes-3-llama-3.1-70b": {
        "id": "nousresearch/hermes-3-llama-3.1-70b",
        "name": "Hermes 3 70B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.7,
          "output": 0.7
        }
      },
      "nousresearch/hermes-3-llama-3.1-405b": {
        "id": "nousresearch/hermes-3-llama-3.1-405b",
        "name": "Hermes 3 405B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 1,
          "output": 1
        }
      },
      "nousresearch/hermes-4-405b": {
        "id": "nousresearch/hermes-4-405b",
        "name": "Hermes 4 405B",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 1,
          "output": 3
        }
      },
      "openai/o4-mini-high": {
        "id": "openai/o4-mini-high",
        "name": "o4 Mini High",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-16",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.275
        }
      },
      "openai/gpt-5-nano": {
        "id": "openai/gpt-5-nano",
        "name": "GPT-5 Nano",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.05,
          "output": 0.4,
          "cache_read": 0.005
        }
      },
      "openai/gpt-4.1-nano": {
        "id": "openai/gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.025
        }
      },
      "openai/gpt-4o-2024-05-13": {
        "id": "openai/gpt-4o-2024-05-13",
        "name": "GPT-4o (2024-05-13)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-05-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 5,
          "output": 15
        }
      },
      "openai/gpt-5-pro": {
        "id": "openai/gpt-5-pro",
        "name": "GPT-5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-10-06",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 15,
          "output": 120
        }
      },
      "openai/gpt-4o-mini-2024-07-18": {
        "id": "openai/gpt-4o-mini-2024-07-18",
        "name": "GPT-4o-mini (2024-07-18)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-07-18",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.075
        }
      },
      "openai/o3-mini-high": {
        "id": "openai/o3-mini-high",
        "name": "o3 Mini High",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-02-12",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.55
        }
      },
      "openai/gpt-5.1-codex-mini": {
        "id": "openai/gpt-5.1-codex-mini",
        "name": "GPT-5.1 Codex mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-11-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.25,
          "output": 2,
          "cache_read": 0.03
        }
      },
      "openai/gpt-6-astra-pro": {
        "id": "openai/gpt-6-astra-pro",
        "name": "GPT-6 Astra Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-04",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "openai/gpt-audio-mini": {
        "id": "openai/gpt-audio-mini",
        "name": "GPT Audio Mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text",
            "audio"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 2.4
        }
      },
      "openai/gpt-5.1-codex": {
        "id": "openai/gpt-5.1-codex",
        "name": "GPT-5.1 Codex",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-11-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.13
        }
      },
      "openai/gpt-5.6-sol": {
        "id": "openai/gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "openai/gpt-4o-2024-08-06": {
        "id": "openai/gpt-4o-2024-08-06",
        "name": "GPT-4o (2024-08-06)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-08-06",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "openai/gpt-5.2-codex": {
        "id": "openai/gpt-5.2-codex",
        "name": "GPT-5.2 Codex",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "openai/gpt-6-astra": {
        "id": "openai/gpt-6-astra",
        "name": "GPT-6 Astra",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-09-04",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      "openai/gpt-5.2-chat": {
        "id": "openai/gpt-5.2-chat",
        "name": "GPT-5.2 Chat",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-10",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "openai/gpt-5.6-luna-pro": {
        "id": "openai/gpt-5.6-luna-pro",
        "name": "GPT-5.6 Luna Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      "openai/gpt-5.2-pro": {
        "id": "openai/gpt-5.2-pro",
        "name": "GPT-5.2 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 21,
          "output": 168
        }
      },
      "openai/gpt-4.1-mini": {
        "id": "openai/gpt-4.1-mini",
        "name": "GPT-4.1 mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 0.4,
          "output": 1.6,
          "cache_read": 0.1
        }
      },
      "openai/gpt-5.4": {
        "id": "openai/gpt-5.4",
        "name": "GPT-5.4",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2.5,
          "output": 15,
          "cache_read": 0.25
        }
      },
      "openai/gpt-oss-20b": {
        "id": "openai/gpt-oss-20b",
        "name": "GPT OSS 20B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.03,
          "output": 0.13,
          "cache_read": 0.03
        }
      },
      "openai/gpt-4-turbo": {
        "id": "openai/gpt-4-turbo",
        "name": "GPT-4 Turbo",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-11-06",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 10,
          "output": 30
        }
      },
      "openai/gpt-5-image": {
        "id": "openai/gpt-5-image",
        "name": "GPT-5 Image",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-14",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "image",
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 10,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "openai/gpt-5.6-sol-pro": {
        "id": "openai/gpt-5.6-sol-pro",
        "name": "GPT-5.6 Sol Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "openai/gpt-oss-safeguard-20b": {
        "id": "openai/gpt-oss-safeguard-20b",
        "name": "GPT OSS Safeguard 20B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.075,
          "output": 0.3,
          "cache_read": 0.0375
        }
      },
      "openai/gpt-5.1": {
        "id": "openai/gpt-5.1",
        "name": "GPT-5.1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-11-13",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "openai/gpt-5.1-codex-max": {
        "id": "openai/gpt-5.1-codex-max",
        "name": "GPT-5.1 Codex Max",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-11-13",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "openai/gpt-5.4-image-2": {
        "id": "openai/gpt-5.4-image-2",
        "name": "GPT-5.4 Image 2",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "image",
            "text"
          ]
        },
        "limit": {
          "context": 272000,
          "output": 128000
        },
        "cost": {
          "input": 8,
          "output": 15,
          "cache_read": 2
        }
      },
      "openai/gpt-3.5-turbo-0613": {
        "id": "openai/gpt-3.5-turbo-0613",
        "name": "GPT-3.5 Turbo (older v0613)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-01-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 4095,
          "output": 3685
        },
        "cost": {
          "input": 1,
          "output": 2
        }
      },
      "openai/gpt-audio": {
        "id": "openai/gpt-audio",
        "name": "GPT Audio",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text",
            "audio"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "openai/o1": {
        "id": "openai/o1",
        "name": "o1",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-12-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 15,
          "output": 60,
          "cache_read": 7.5
        }
      },
      "openai/gpt-4o": {
        "id": "openai/gpt-4o",
        "name": "GPT-4o",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-05-13",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "openai/gpt-5.6-luna": {
        "id": "openai/gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      "openai/gpt-5.3-codex": {
        "id": "openai/gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-02-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "openai/gpt-4o-mini": {
        "id": "openai/gpt-4o-mini",
        "name": "GPT-4o mini",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-07-18",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.075
        }
      },
      "openai/o1-pro": {
        "id": "openai/o1-pro",
        "name": "o1-pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-03-19",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 150,
          "output": 600
        }
      },
      "openai/gpt-4.1": {
        "id": "openai/gpt-4.1",
        "name": "GPT-4.1",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 2,
          "output": 8,
          "cache_read": 0.5
        }
      },
      "openai/gpt-5.4-nano": {
        "id": "openai/gpt-5.4-nano",
        "name": "GPT-5.4 nano",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-17",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.25,
          "cache_read": 0.02
        }
      },
      "openai/gpt-5.6-terra-pro": {
        "id": "openai/gpt-5.6-terra-pro",
        "name": "GPT-5.6 Terra Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "openai/gpt-5.5-pro": {
        "id": "openai/gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 30,
          "output": 180
        }
      },
      "openai/gpt-chat-latest": {
        "id": "openai/gpt-chat-latest",
        "name": "GPT Chat Latest",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-05-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      "openai/gpt-5.4-mini": {
        "id": "openai/gpt-5.4-mini",
        "name": "GPT-5.4 mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-17",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.75,
          "output": 4.5,
          "cache_read": 0.075
        }
      },
      "openai/gpt-3.5-turbo-16k": {
        "id": "openai/gpt-3.5-turbo-16k",
        "name": "GPT-3.5 Turbo 16k",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-08-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16385,
          "output": 4096
        },
        "cost": {
          "input": 3,
          "output": 4
        }
      },
      "openai/gpt-5-image-mini": {
        "id": "openai/gpt-5-image-mini",
        "name": "GPT-5 Image Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-16",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "image",
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 2.5,
          "output": 2,
          "cache_read": 0.25
        }
      },
      "openai/gpt-3.5-turbo": {
        "id": "openai/gpt-3.5-turbo",
        "name": "GPT-3.5-turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-03-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16385,
          "output": 4096
        },
        "cost": {
          "input": 0.5,
          "output": 1.5
        }
      },
      "openai/gpt-5-mini": {
        "id": "openai/gpt-5-mini",
        "name": "GPT-5 Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 0.25,
          "output": 2,
          "cache_read": 0.025
        }
      },
      "openai/gpt-oss-120b": {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.037,
          "output": 0.17
        }
      },
      "openai/gpt-5.4-pro": {
        "id": "openai/gpt-5.4-pro",
        "name": "GPT-5.4 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-05",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 30,
          "output": 180
        }
      },
      "openai/gpt-3.5-turbo-instruct": {
        "id": "openai/gpt-3.5-turbo-instruct",
        "name": "GPT-3.5 Turbo Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-09-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 4095,
          "output": 3685
        },
        "cost": {
          "input": 1.5,
          "output": 2
        }
      },
      "openai/gpt-5.6-terra": {
        "id": "openai/gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "openai/gpt-4": {
        "id": "openai/gpt-4",
        "name": "GPT-4",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2023-11-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8191,
          "output": 4096
        },
        "cost": {
          "input": 30,
          "output": 60
        }
      },
      "openai/gpt-5.2": {
        "id": "openai/gpt-5.2",
        "name": "GPT-5.2",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-12-11",
        "modalities": {
          "input": [
            "pdf",
            "image",
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      "openai/gpt-5": {
        "id": "openai/gpt-5",
        "name": "GPT-5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "output": 128000
        },
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      "openai/o4-mini": {
        "id": "openai/o4-mini",
        "name": "o4-mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-16",
        "modalities": {
          "input": [
            "image",
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.275
        }
      },
      "openai/o3-mini": {
        "id": "openai/o3-mini",
        "name": "o3-mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2024-12-20",
        "modalities": {
          "input": [
            "text",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 1.1,
          "output": 4.4,
          "cache_read": 0.55
        }
      },
      "openai/o3": {
        "id": "openai/o3",
        "name": "o3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-04-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 2,
          "output": 8,
          "cache_read": 0.5
        }
      },
      "openai/o3-pro": {
        "id": "openai/o3-pro",
        "name": "o3-pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2025-06-10",
        "modalities": {
          "input": [
            "text",
            "pdf",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 100000
        },
        "cost": {
          "input": 20,
          "output": 80
        }
      },
      "openai/gpt-5.5": {
        "id": "openai/gpt-5.5",
        "name": "GPT-5.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "output": 128000
        },
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      "openai/gpt-4o-2024-11-20": {
        "id": "openai/gpt-4o-2024-11-20",
        "name": "GPT-4o (2024-11-20)",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-11-20",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 2.5,
          "output": 10,
          "cache_read": 1.25
        }
      },
      "~z-ai/glm-flash-latest": {
        "id": "~z-ai/glm-flash-latest",
        "name": "GLM Flash Latest",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 131072
        },
        "cost": {
          "input": 0.075,
          "output": 0.25,
          "cache_read": 0.015
        }
      },
      "~z-ai/glm-latest": {
        "id": "~z-ai/glm-latest",
        "name": "GLM Latest",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 235929
        },
        "cost": {
          "input": 0.8775,
          "output": 2.97,
          "cache_read": 0.1755
        }
      },
      "moonshotai/kimi-k2-0905": {
        "id": "moonshotai/kimi-k2-0905",
        "name": "Kimi K2 0905",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 98304
        },
        "cost": {
          "input": 0.6,
          "output": 2.5
        }
      },
      "moonshotai/kimi-k2.6": {
        "id": "moonshotai/kimi-k2.6",
        "name": "Kimi K2.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      "moonshotai/kimi-k2.7-code": {
        "id": "moonshotai/kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.7062,
          "output": 3.21,
          "cache_read": 0.18
        }
      },
      "moonshotai/kimi-k2-thinking": {
        "id": "moonshotai/kimi-k2-thinking",
        "name": "Kimi K2 Thinking",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-11-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 98304
        },
        "cost": {
          "input": 0.6,
          "output": 2.5,
          "cache_read": 0.15
        }
      },
      "moonshotai/kimi-k3": {
        "id": "moonshotai/kimi-k3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 943718
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3
        }
      },
      "moonshotai/kimi-k2": {
        "id": "moonshotai/kimi-k2",
        "name": "Kimi K2 0711",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.57,
          "output": 2.3
        }
      },
      "moonshotai/kimi-k2.5": {
        "id": "moonshotai/kimi-k2.5",
        "name": "Kimi K2.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.45,
          "output": 2.25,
          "cache_read": 0.07
        }
      },
      "inference-net/schematron-v2-small": {
        "id": "inference-net/schematron-v2-small",
        "name": "Schematron V2 Small",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4096
        },
        "cost": {
          "input": 0.05,
          "output": 0.23,
          "cache_read": 0.05
        }
      },
      "inference-net/schematron-v2-turbo": {
        "id": "inference-net/schematron-v2-turbo",
        "name": "Schematron V2 Turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 8192
        },
        "cost": {
          "input": 0.03,
          "output": 0.15,
          "cache_read": 0.03
        }
      },
      "cohere/north-mini-code:free": {
        "id": "cohere/north-mini-code:free",
        "name": "North Mini Code (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 64000
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "cohere/command-r-plus-08-2024": {
        "id": "cohere/command-r-plus-08-2024",
        "name": "Command R+",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "cohere/command-a": {
        "id": "cohere/command-a",
        "name": "Command A",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 8192
        },
        "cost": {
          "input": 2.5,
          "output": 10
        }
      },
      "cohere/command-r7b-12-2024": {
        "id": "cohere/command-r7b-12-2024",
        "name": "Command R7B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 0.0375,
          "output": 0.15
        }
      },
      "cohere/command-r-08-2024": {
        "id": "cohere/command-r-08-2024",
        "name": "Command R",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-08-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 4000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6
        }
      },
      "upstage/solar-pro-3": {
        "id": "upstage/solar-pro-3",
        "name": "Solar Pro 3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-01-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.015
        }
      },
      "upstage/solar-pro4": {
        "id": "upstage/solar-pro4",
        "name": "Solar Pro 4",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 524288,
          "output": 131072
        },
        "cost": {
          "input": 0.09,
          "output": 0.36,
          "cache_read": 0.018
        }
      },
      "arcee-ai/trinity-large-thinking": {
        "id": "arcee-ai/trinity-large-thinking",
        "name": "Trinity Large Thinking",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 80000
        },
        "cost": {
          "input": 0.25,
          "output": 0.8,
          "cache_read": 0.06
        }
      },
      "tencent/hy3": {
        "id": "tencent/hy3",
        "name": "Hy3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 128000
        },
        "cost": {
          "input": 0.132,
          "output": 0.528,
          "cache_read": 0.033
        }
      },
      "tencent/hy4-preview": {
        "id": "tencent/hy4-preview",
        "name": "Hy4 preview",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 64000
        },
        "cost": {
          "input": 0.834,
          "output": 2.501,
          "cache_read": 0.042
        }
      },
      "tencent/hy-mt2-30b-a3b": {
        "id": "tencent/hy-mt2-30b-a3b",
        "name": "Hy-MT2-30B-A3B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 4096
        },
        "cost": {
          "input": 0.074,
          "output": 0.295
        }
      },
      "tencent/hy-mt2-7b": {
        "id": "tencent/hy-mt2-7b",
        "name": "Hy-MT2-7B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 4096
        },
        "cost": {
          "input": 0.074,
          "output": 0.295
        }
      },
      "tencent/hy-mt2-1.8b": {
        "id": "tencent/hy-mt2-1.8b",
        "name": "Hy-MT2-1.8B",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 4096
        },
        "cost": {
          "input": 0.044,
          "output": 0.177
        }
      },
      "tencent/hy3-preview": {
        "id": "tencent/hy3-preview",
        "name": "Hy3 preview",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0.18,
          "output": 0.6,
          "cache_read": 0.06
        }
      },
      "tencent/hunyuan-a13b-instruct": {
        "id": "tencent/hunyuan-a13b-instruct",
        "name": "Hunyuan A13B Instruct",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "liquid/lfm-2.5-2.6b:free": {
        "id": "liquid/lfm-2.5-2.6b:free",
        "name": "LFM2.5-2.6B (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 8192
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "z-ai/glm-4.7": {
        "id": "z-ai/glm-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.4,
          "output": 1.75,
          "cache_read": 0.08
        }
      },
      "z-ai/glm-4.5-air": {
        "id": "z-ai/glm-4.5-air",
        "name": "GLM-4.5-Air",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.13,
          "output": 0.85,
          "cache_read": 0.025
        }
      },
      "z-ai/glm-4.6": {
        "id": "z-ai/glm-4.6",
        "name": "GLM-4.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 16384
        },
        "cost": {
          "input": 0.43,
          "output": 1.75,
          "cache_read": 0.08
        }
      },
      "z-ai/glm-4.6v": {
        "id": "z-ai/glm-4.6v",
        "name": "GLM-4.6V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 0.9,
          "cache_read": 0.055
        }
      },
      "z-ai/glm-5.2": {
        "id": "z-ai/glm-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.14
        }
      },
      "z-ai/glm-5.3-flash": {
        "id": "z-ai/glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 131072
        },
        "cost": {
          "input": 0.09,
          "output": 0.3,
          "cache_read": 0.018
        }
      },
      "z-ai/glm-4.5": {
        "id": "z-ai/glm-4.5",
        "name": "GLM-4.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11
        }
      },
      "z-ai/glm-4.5v": {
        "id": "z-ai/glm-4.5v",
        "name": "GLM-4.5V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 1.8,
          "cache_read": 0.11
        }
      },
      "z-ai/glm-5.2:free": {
        "id": "z-ai/glm-5.2:free",
        "name": "GLM 5.2 (free)",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 29491
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "z-ai/glm-5": {
        "id": "z-ai/glm-5",
        "name": "GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 128000
        },
        "cost": {
          "input": 0.6,
          "output": 1.92,
          "cache_read": 0.12
        }
      },
      "z-ai/glm-5.1": {
        "id": "z-ai/glm-5.1",
        "name": "GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 128000
        },
        "cost": {
          "input": 0.966,
          "output": 3.036,
          "cache_read": 0.1794
        }
      },
      "z-ai/glm-5-turbo": {
        "id": "z-ai/glm-5-turbo",
        "name": "GLM-5-Turbo",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.24
        }
      },
      "z-ai/glm-5.3": {
        "id": "z-ai/glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 943717
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      "z-ai/glm-5v-turbo": {
        "id": "z-ai/glm-5v-turbo",
        "name": "GLM-5V-Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.24
        }
      },
      "z-ai/glm-4.7-flash": {
        "id": "z-ai/glm-4.7-flash",
        "name": "GLM-4.7-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 117964
        },
        "cost": {
          "input": 0.0605,
          "output": 0.4
        }
      },
      "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
        "id": "cognitivecomputations/dolphin-mistral-24b-venice-edition",
        "name": "Uncensored",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 8192
        },
        "cost": {
          "input": 0.2,
          "output": 0.9
        }
      },
      "perplexity/sonar-pro-search": {
        "id": "perplexity/sonar-pro-search",
        "name": "Sonar Pro Search",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-30",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 8000
        },
        "cost": {
          "input": 3,
          "output": 15
        }
      },
      "perplexity/sonar": {
        "id": "perplexity/sonar",
        "name": "Sonar",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-01-27",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 127072,
          "output": 114364
        },
        "cost": {
          "input": 1,
          "output": 1
        }
      },
      "perplexity/sonar-reasoning-pro": {
        "id": "perplexity/sonar-reasoning-pro",
        "name": "Sonar Reasoning Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-03-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 115200
        },
        "cost": {
          "input": 2,
          "output": 8
        }
      },
      "perplexity/sonar-pro": {
        "id": "perplexity/sonar-pro",
        "name": "Sonar Pro",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-03-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 8000
        },
        "cost": {
          "input": 3,
          "output": 15
        }
      },
      "perplexity/sonar-deep-research": {
        "id": "perplexity/sonar-deep-research",
        "name": "Sonar Deep Research",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-03-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 115200
        },
        "cost": {
          "input": 2,
          "output": 8,
          "reasoning": 3
        }
      },
      "rekaai/reka-edge": {
        "id": "rekaai/reka-edge",
        "name": "Reka Edge",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-20",
        "modalities": {
          "input": [
            "image",
            "text",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 14745
        },
        "cost": {
          "input": 0.1,
          "output": 0.1
        }
      },
      "rekaai/reka-flash-3": {
        "id": "rekaai/reka-flash-3",
        "name": "Reka Flash 3",
        "attachment": false,
        "reasoning": true,
        "toolCall": false,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 65536,
          "output": 58982
        },
        "cost": {
          "input": 0.1,
          "output": 0.2
        }
      },
      "stealth/union-alpha": {
        "id": "stealth/union-alpha",
        "name": "Union Alpha",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-09-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      }
    }
  },
  "deepinfra": {
    "name": "Deep Infra",
    "doc": "https://deepinfra.com/models",
    "env": [
      "DEEPINFRA_API_KEY"
    ],
    "models": {
      "ByteDance/Seed-2.0-mini": {
        "id": "ByteDance/Seed-2.0-mini",
        "name": "Seed 2.0 Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 32000
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.02
        }
      },
      "ByteDance/Seed-2.0-code": {
        "id": "ByteDance/Seed-2.0-code",
        "name": "Seed 2.0 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 131072
        },
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.1
        }
      },
      "ByteDance/Seed-2.0-pro": {
        "id": "ByteDance/Seed-2.0-pro",
        "name": "Seed 2.0 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 128000
        },
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.1
        }
      },
      "stepfun-ai/Step-3.7-Flash": {
        "id": "stepfun-ai/Step-3.7-Flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 256000
        },
        "cost": {
          "input": 0.2,
          "output": 1.15,
          "cache_read": 0.04
        }
      },
      "deepseek-ai/DeepSeek-V3": {
        "id": "deepseek-ai/DeepSeek-V3",
        "name": "DeepSeek-V3",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2024-12-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 8192
        },
        "cost": {
          "input": 0.32,
          "output": 0.89
        }
      },
      "deepseek-ai/DeepSeek-V4-Flash": {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 16384
        },
        "cost": {
          "input": 0.09,
          "output": 0.18,
          "cache_read": 0.018
        }
      },
      "deepseek-ai/DeepSeek-V3-0324": {
        "id": "deepseek-ai/DeepSeek-V3-0324",
        "name": "DeepSeek V3 0324",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 163840
        },
        "cost": {
          "input": 0.24,
          "output": 0.9,
          "cache_read": 0.135
        }
      },
      "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
        "id": "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 0.44,
          "output": 1.32,
          "cache_read": 0.014
        }
      },
      "deepseek-ai/DeepSeek-V4-Flash-0731": {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 0.06,
          "output": 0.18,
          "cache_read": 0.015
        }
      },
      "deepseek-ai/DeepSeek-V3.1": {
        "id": "deepseek-ai/DeepSeek-V3.1",
        "name": "DeepSeek-V3.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 8192
        },
        "cost": {
          "input": 0.25,
          "output": 0.95,
          "cache_read": 0.13
        }
      },
      "deepseek-ai/DeepSeek-R1-0528": {
        "id": "deepseek-ai/DeepSeek-R1-0528",
        "name": "DeepSeek-R1-0528",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 64000
        },
        "cost": {
          "input": 0.5,
          "output": 2.15,
          "cache_read": 0.35
        }
      },
      "deepseek-ai/DeepSeek-V4.1-Flash": {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 0.2,
          "output": 0.6,
          "cache_read": 0.006
        }
      },
      "deepseek-ai/DeepSeek-V4-Pro-0813": {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 384000
        },
        "cost": {
          "input": 1.3,
          "output": 2.6,
          "cache_read": 0.1
        }
      },
      "deepseek-ai/DeepSeek-V3.2": {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek-V3.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 163840,
          "output": 64000
        },
        "cost": {
          "input": 0.26,
          "output": 0.38,
          "cache_read": 0.13
        }
      },
      "deepseek-ai/DeepSeek-V4-Pro": {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 16384
        },
        "cost": {
          "input": 1.3,
          "output": 2.6,
          "cache_read": 0.1
        }
      },
      "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning": {
        "id": "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning",
        "name": "Nemotron 3 Nano Omni 30B A3B Reasoning",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.2,
          "output": 0.8
        }
      },
      "nvidia/Llama-3.3-Nemotron-Super-49B-v1.5": {
        "id": "nvidia/Llama-3.3-Nemotron-Super-49B-v1.5",
        "name": "Llama 3.3 Nemotron Super 49B v1.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.4,
          "output": 0.4
        }
      },
      "nvidia/Nemotron-3-Nano-30B-A3B": {
        "id": "nvidia/Nemotron-3-Nano-30B-A3B",
        "name": "Nemotron 3 Nano 30B A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.05,
          "output": 0.2,
          "cache_read": 0.025
        }
      },
      "google/gemma-3-4b-it": {
        "id": "google/gemma-3-4b-it",
        "name": "Gemma 3 4B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.05,
          "output": 0.1
        }
      },
      "google/gemma-4-31B-it": {
        "id": "google/gemma-4-31B-it",
        "name": "Gemma 4 31B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.13,
          "output": 0.38
        }
      },
      "google/gemma-4-E4B-it": {
        "id": "google/gemma-4-E4B-it",
        "name": "Gemma 4 E4B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 8192
        },
        "cost": {
          "input": 0.02,
          "output": 0.1
        }
      },
      "google/gemma-3-27b-it": {
        "id": "google/gemma-3-27b-it",
        "name": "Gemma 3 27B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.08,
          "output": 0.16
        }
      },
      "google/gemma-4-26B-A4B-it": {
        "id": "google/gemma-4-26B-A4B-it",
        "name": "Gemma 4 26B A4B IT",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.07,
          "output": 0.34
        }
      },
      "google/gemma-3-12b-it": {
        "id": "google/gemma-3-12b-it",
        "name": "Gemma 3 12B IT",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-03-12",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.05,
          "output": 0.15
        }
      },
      "zai-org/GLM-5.1": {
        "id": "zai-org/GLM-5.1",
        "name": "GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 16384
        },
        "cost": {
          "input": 1.05,
          "output": 3.5,
          "cache_read": 0.205
        }
      },
      "zai-org/GLM-5.3": {
        "id": "zai-org/GLM-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.2
        }
      },
      "zai-org/GLM-5.2": {
        "id": "zai-org/GLM-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 32768
        },
        "cost": {
          "input": 0.75,
          "output": 2.4,
          "cache_read": 0.14
        }
      },
      "zai-org/GLM-4.7-Flash": {
        "id": "zai-org/GLM-4.7-Flash",
        "name": "GLM-4.7-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 16384
        },
        "cost": {
          "input": 0.06,
          "output": 0.4,
          "cache_read": 0.01
        }
      },
      "zai-org/GLM-4.7": {
        "id": "zai-org/GLM-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 16384
        },
        "cost": {
          "input": 0.4,
          "output": 1.75,
          "cache_read": 0.08
        }
      },
      "zai-org/GLM-5": {
        "id": "zai-org/GLM-5",
        "name": "GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 2.08,
          "cache_read": 0.12
        }
      },
      "zai-org/GLM-4.6": {
        "id": "zai-org/GLM-4.6",
        "name": "GLM-4.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 202752,
          "output": 131072
        },
        "cost": {
          "input": 0.5,
          "output": 2,
          "cache_read": 0.1
        }
      },
      "zai-org/GLM-5.3-Flash": {
        "id": "zai-org/GLM-5.3-Flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 0.15,
          "output": 0.5,
          "cache_read": 0.03
        }
      },
      "thinkingmachines/Inkling-Small": {
        "id": "thinkingmachines/Inkling-Small",
        "name": "Inkling Small",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 524288,
          "output": 1048576
        },
        "cost": {
          "input": 0.45,
          "output": 1.2,
          "cache_read": 0.1
        }
      },
      "thinkingmachines/Inkling": {
        "id": "thinkingmachines/Inkling",
        "name": "Inkling",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 524288,
          "output": 1048576
        },
        "cost": {
          "input": 0.95,
          "output": 4.05,
          "cache_read": 0.16
        }
      },
      "Qwen/Qwen3.7-Max": {
        "id": "Qwen/Qwen3.7-Max",
        "name": "Qwen3.7 Max",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 65536
        },
        "cost": {
          "input": 2.5,
          "output": 7.5,
          "cache_read": 0.5
        }
      },
      "Qwen/Qwen3.8-27B": {
        "id": "Qwen/Qwen3.8-27B",
        "name": "Qwen3.8 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.2,
          "output": 2.5,
          "cache_read": 0.05
        }
      },
      "Qwen/Qwen3.5-27B": {
        "id": "Qwen/Qwen3.5-27B",
        "name": "Qwen3.5 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.26,
          "output": 2.6
        }
      },
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
        "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
        "name": "Qwen3 Coder 480B A35B Instruct Turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 66536
        },
        "cost": {
          "input": 0.3,
          "output": 1,
          "cache_read": 0.1
        }
      },
      "Qwen/Qwen3.8-Max": {
        "id": "Qwen/Qwen3.8-Max",
        "name": "Qwen3.8 Max",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-08-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 131072
        },
        "cost": {
          "input": 1.65,
          "output": 4.951,
          "cache_read": 0.206
        }
      },
      "Qwen/Qwen3.5-9B": {
        "id": "Qwen/Qwen3.5-9B",
        "name": "Qwen3.5 9B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.1,
          "output": 0.15
        }
      },
      "Qwen/Qwen3-30B-A3B": {
        "id": "Qwen/Qwen3-30B-A3B",
        "name": "Qwen3 30B A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 40960,
          "output": 16384
        },
        "cost": {
          "input": 0.12,
          "output": 0.5
        }
      },
      "Qwen/Qwen3.5-122B-A10B": {
        "id": "Qwen/Qwen3.5-122B-A10B",
        "name": "Qwen3.5 122B-A10B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.29,
          "output": 2.4
        }
      },
      "Qwen/Qwen3.8-2.4T-A95B": {
        "id": "Qwen/Qwen3.8-2.4T-A95B",
        "name": "Qwen3.8 2.4T A95B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.2
        }
      },
      "Qwen/Qwen3-235B-A22B-Instruct-2507": {
        "id": "Qwen/Qwen3-235B-A22B-Instruct-2507",
        "name": "Qwen3 235B-A22B Instruct 2507",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-21",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 16384
        },
        "cost": {
          "input": 0.09,
          "output": 0.55
        }
      },
      "Qwen/Qwen3.8-Flash": {
        "id": "Qwen/Qwen3.8-Flash",
        "name": "Qwen3.8 Flash",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "openWeights": false,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.113,
          "output": 0.382,
          "cache_read": 0.0141
        }
      },
      "Qwen/Qwen3-VL-235B-A22B-Instruct": {
        "id": "Qwen/Qwen3-VL-235B-A22B-Instruct",
        "name": "Qwen3 VL 235B A22B Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-23",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.2,
          "output": 0.88,
          "cache_read": 0.11
        }
      },
      "Qwen/Qwen3-Next-80B-A3B-Instruct": {
        "id": "Qwen/Qwen3-Next-80B-A3B-Instruct",
        "name": "Qwen3-Next 80B-A3B Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.09,
          "output": 1.1
        }
      },
      "Qwen/Qwen3.5-397B-A17B": {
        "id": "Qwen/Qwen3.5-397B-A17B",
        "name": "Qwen 3.5 397B A17B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 81920
        },
        "cost": {
          "input": 0.45,
          "output": 3,
          "cache_read": 0.22
        }
      },
      "Qwen/Qwen3.5-35B-A3B": {
        "id": "Qwen/Qwen3.5-35B-A3B",
        "name": "Qwen 3.5 35B A3B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 81920
        },
        "cost": {
          "input": 0.14,
          "output": 1,
          "cache_read": 0.05
        }
      },
      "Qwen/Qwen3-32B": {
        "id": "Qwen/Qwen3-32B",
        "name": "Qwen3 32B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 40960,
          "output": 16384
        },
        "cost": {
          "input": 0.08,
          "output": 0.28
        }
      },
      "Qwen/Qwen3.6-27B": {
        "id": "Qwen/Qwen3.6-27B",
        "name": "Qwen3.6 27B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.32,
          "output": 3.2
        }
      },
      "Qwen/Qwen3.6-35B-A3B": {
        "id": "Qwen/Qwen3.6-35B-A3B",
        "name": "Qwen3.6 35B A3B",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 81920
        },
        "cost": {
          "input": 0.1,
          "output": 0.95
        }
      },
      "Qwen/Qwen3-Max": {
        "id": "Qwen/Qwen3-Max",
        "name": "Qwen3 Max",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 65536
        },
        "cost": {
          "input": 1.2,
          "output": 6,
          "cache_read": 0.24
        }
      },
      "MiniMaxAI/MiniMax-M2.5": {
        "id": "MiniMaxAI/MiniMax-M2.5",
        "name": "MiniMax M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 196608,
          "output": 131072
        },
        "cost": {
          "input": 0.15,
          "output": 1.15,
          "cache_read": 0.03
        }
      },
      "MiniMaxAI/MiniMax-M3": {
        "id": "MiniMaxAI/MiniMax-M3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 524288,
          "output": 512000
        },
        "cost": {
          "input": 0.28,
          "output": 1.1,
          "cache_read": 0.056
        }
      },
      "MiniMaxAI/MiniMax-M2.7": {
        "id": "MiniMaxAI/MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 196608,
          "output": 131072
        },
        "cost": {
          "input": 0.25,
          "output": 1,
          "cache_read": 0.05
        }
      },
      "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
        "id": "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        "name": "Llama 4 Scout 17B",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "openWeights": true,
        "releaseDate": "2025-04-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 327680,
          "output": 16384
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
        "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "name": "Llama 3.3 70B Turbo",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "openWeights": true,
        "releaseDate": "2024-12-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.1,
          "output": 0.32
        }
      },
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
        "id": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        "name": "Llama 4 Maverick 17B FP8",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "structuredOutput": true,
        "openWeights": true,
        "releaseDate": "2025-04-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 16384
        },
        "cost": {
          "input": 0.2,
          "output": 0.8
        }
      },
      "openai/gpt-oss-20b": {
        "id": "openai/gpt-oss-20b",
        "name": "GPT OSS 20B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.03,
          "output": 0.14
        }
      },
      "openai/gpt-oss-120b": {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-05",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 16384
        },
        "cost": {
          "input": 0.037,
          "output": 0.17
        }
      },
      "moonshotai/Kimi-K2.5": {
        "id": "moonshotai/Kimi-K2.5",
        "name": "Kimi K2.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-27",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.45,
          "output": 2.25,
          "cache_read": 0.07
        }
      },
      "moonshotai/Kimi-K2.7-Code": {
        "id": "moonshotai/Kimi-K2.7-Code",
        "name": "Kimi K2.7 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.68,
          "output": 3.4,
          "cache_read": 0.136
        }
      },
      "moonshotai/Kimi-K2.6": {
        "id": "moonshotai/Kimi-K2.6",
        "name": "Kimi K2.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 16384
        },
        "cost": {
          "input": 0.75,
          "output": 3.5,
          "cache_read": 0.15
        }
      },
      "moonshotai/Kimi-K3": {
        "id": "moonshotai/Kimi-K3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 2.85,
          "output": 14.25,
          "cache_read": 0.285
        }
      },
      "tencent/Hy3": {
        "id": "tencent/Hy3",
        "name": "Hy3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-06",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 128000
        },
        "cost": {
          "input": 0.14,
          "output": 0.58,
          "cache_read": 0.035
        }
      },
      "XiaomiMiMo/MiMo-V2.5-Pro": {
        "id": "XiaomiMiMo/MiMo-V2.5-Pro",
        "name": "MiMo-V2.5-Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 16384
        },
        "cost": {
          "input": 1,
          "output": 3,
          "cache_read": 0.2
        }
      },
      "XiaomiMiMo/MiMo-V2.5": {
        "id": "XiaomiMiMo/MiMo-V2.5",
        "name": "MiMo-V2.5",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 16384
        },
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.0028
        }
      }
    }
  },
  "deepseek": {
    "name": "DeepSeek",
    "api": "https://api.deepseek.com",
    "doc": "https://api-docs.deepseek.com/quick_start/pricing",
    "env": [
      "DEEPSEEK_API_KEY"
    ],
    "models": {
      "deepseek-v4-flash-vision-exp": {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "reasoning": 0.6,
          "cache_read": 0.003
        }
      },
      "deepseek-v4-flash": {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "reasoning": 0.6,
          "cache_read": 0.003
        }
      },
      "deepseek-v4-pro": {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.435,
          "output": 0.87,
          "reasoning": 0.87,
          "cache_read": 0.003625
        }
      },
      "deepseek-flash": {
        "id": "deepseek-flash",
        "name": "DeepSeek V4.1 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-09-10",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "reasoning": 0.6,
          "cache_read": 0.003
        }
      }
    }
  },
  "moonshotai": {
    "name": "Moonshot AI",
    "api": "https://api.moonshot.ai/v1",
    "doc": "https://platform.moonshot.ai/docs/api/chat",
    "env": [
      "MOONSHOT_API_KEY"
    ],
    "models": {
      "kimi-k2.7-code-highspeed": {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code HighSpeed",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 1.9,
          "output": 8,
          "cache_read": 0.38
        }
      },
      "kimi-k2.6": {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      "kimi-k2.7-code": {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.19
        }
      },
      "kimi-k3": {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3
        }
      }
    }
  },
  "moonshotai-cn": {
    "name": "Moonshot AI (China)",
    "api": "https://api.moonshot.cn/v1",
    "doc": "https://platform.moonshot.cn/docs/api/chat",
    "env": [
      "MOONSHOT_API_KEY"
    ],
    "models": {
      "kimi-k3": {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3
        }
      },
      "kimi-k2.7-code": {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.19
        }
      },
      "kimi-k2.6": {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      "kimi-k2.7-code-highspeed": {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code HighSpeed",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 1.9,
          "output": 8,
          "cache_read": 0.38
        }
      }
    }
  },
  "kimi-for-coding": {
    "name": "Kimi For Coding",
    "api": "https://api.kimi.com/coding/v1",
    "doc": "https://www.kimi.com/code/docs/en/kimi-code/models.html",
    "env": [
      "KIMI_API_KEY"
    ],
    "models": {
      "kimi-for-coding-highspeed": {
        "id": "kimi-for-coding-highspeed",
        "name": "Kimi For Coding HighSpeed",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "k3-256k": {
        "id": "k3-256k",
        "name": "Kimi K3-256K",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "kimi-for-coding": {
        "id": "kimi-for-coding",
        "name": "kimi-for-coding",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "openWeights": false,
        "releaseDate": "2026-09-11",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 32768
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "k3": {
        "id": "k3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "zhipuai": {
    "name": "Zhipu AI",
    "api": "https://open.bigmodel.cn/api/paas/v4",
    "doc": "https://docs.z.ai/guides/overview/pricing",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "models": {
      "glm-5.2": {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.075,
          "output": 0.25,
          "cache_read": 0.015,
          "cache_write": 0
        }
      },
      "glm-5": {
        "id": "glm-5",
        "name": "GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 1,
          "output": 3.2,
          "cache_read": 0.2,
          "cache_write": 0
        }
      },
      "glm-5.1": {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-5.3": {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-5v-turbo": {
        "id": "glm-5v-turbo",
        "name": "GLM-5V-Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 5,
          "output": 22,
          "cache_read": 1.2,
          "cache_write": 0
        }
      },
      "glm-4.7-flash": {
        "id": "glm-4.7-flash",
        "name": "GLM-4.7-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-4.7-flashx": {
        "id": "glm-4.7-flashx",
        "name": "GLM-4.7-FlashX",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0.07,
          "output": 0.4,
          "cache_read": 0.01,
          "cache_write": 0
        }
      },
      "glm-4.5v": {
        "id": "glm-4.5v",
        "name": "GLM-4.5V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-11",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 64000,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 1.8
        }
      },
      "glm-4.5": {
        "id": "glm-4.5",
        "name": "GLM-4.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      },
      "glm-4.5-flash": {
        "id": "glm-4.5-flash",
        "name": "GLM-4.5-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-4.6v": {
        "id": "glm-4.6v",
        "name": "GLM-4.6V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 0.9
        }
      },
      "glm-4.6": {
        "id": "glm-4.6",
        "name": "GLM-4.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      },
      "glm-4.5-air": {
        "id": "glm-4.5-air",
        "name": "GLM-4.5-Air",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.2,
          "output": 1.1,
          "cache_read": 0.03,
          "cache_write": 0
        }
      },
      "glm-4.7": {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      }
    }
  },
  "zhipuai-coding-plan": {
    "name": "Zhipu AI Coding Plan",
    "api": "https://open.bigmodel.cn/api/coding/paas/v4",
    "doc": "https://docs.bigmodel.cn/cn/coding-plan/overview",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "models": {
      "glm-5.3-highspeed": {
        "id": "glm-5.3-highspeed",
        "name": "GLM-5.3 Highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.1": {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3": {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5v-turbo": {
        "id": "glm-5v-turbo",
        "name": "GLM-5V-Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5-turbo": {
        "id": "glm-5-turbo",
        "name": "GLM-5-Turbo",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.2": {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-4.6v": {
        "id": "glm-4.6v",
        "name": "GLM-4.6V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 0.9
        }
      },
      "glm-4.7": {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.2-highspeed": {
        "id": "glm-5.2-highspeed",
        "name": "GLM-5.2 Highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "zai": {
    "name": "Z.AI",
    "api": "https://api.z.ai/api/paas/v4",
    "doc": "https://docs.z.ai/guides/overview/pricing",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "models": {
      "glm-4.7": {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      },
      "glm-4.5-air": {
        "id": "glm-4.5-air",
        "name": "GLM-4.5-Air",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.2,
          "output": 1.1,
          "cache_read": 0.03,
          "cache_write": 0
        }
      },
      "glm-4.6": {
        "id": "glm-4.6",
        "name": "GLM-4.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-09-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      },
      "glm-4.6v": {
        "id": "glm-4.6v",
        "name": "GLM-4.6V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 0.9
        }
      },
      "glm-5.2": {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-4.5-flash": {
        "id": "glm-4.5-flash",
        "name": "GLM-4.5-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.075,
          "output": 0.25,
          "cache_read": 0.015,
          "cache_write": 0
        }
      },
      "glm-4.5": {
        "id": "glm-4.5",
        "name": "GLM-4.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.6,
          "output": 2.2,
          "cache_read": 0.11,
          "cache_write": 0
        }
      },
      "glm-4.5v": {
        "id": "glm-4.5v",
        "name": "GLM-4.5V",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-08-11",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 64000,
          "output": 16384
        },
        "cost": {
          "input": 0.6,
          "output": 1.8
        }
      },
      "glm-4.7-flashx": {
        "id": "glm-4.7-flashx",
        "name": "GLM-4.7-FlashX",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0.07,
          "output": 0.4,
          "cache_read": 0.01,
          "cache_write": 0
        }
      },
      "glm-5": {
        "id": "glm-5",
        "name": "GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 1,
          "output": 3.2,
          "cache_read": 0.2,
          "cache_write": 0
        }
      },
      "glm-5.1": {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-07",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-5-turbo": {
        "id": "glm-5-turbo",
        "name": "GLM-5-Turbo",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.24,
          "cache_write": 0
        }
      },
      "glm-5.3": {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "glm-5v-turbo": {
        "id": "glm-5v-turbo",
        "name": "GLM-5V-Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.24,
          "cache_write": 0
        }
      },
      "glm-4.7-flash": {
        "id": "glm-4.7-flash",
        "name": "GLM-4.7-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "zai-coding-plan": {
    "name": "Z.AI Coding Plan",
    "api": "https://api.z.ai/api/coding/paas/v4",
    "doc": "https://docs.z.ai/devpack/overview",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "models": {
      "glm-5.2-highspeed": {
        "id": "glm-5.2-highspeed",
        "name": "GLM-5.2 Highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-4.7": {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.2": {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3-highspeed": {
        "id": "glm-5.3-highspeed",
        "name": "GLM-5.3 Highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5-turbo": {
        "id": "glm-5-turbo",
        "name": "GLM-5-Turbo",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3": {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "siliconflow": {
    "name": "SiliconFlow",
    "api": "https://api.siliconflow.com/v1",
    "doc": "https://cloud.siliconflow.com/models",
    "env": [
      "SILICONFLOW_API_KEY"
    ],
    "models": {
      "baidu/ERNIE-4.5-300B-A47B": {
        "id": "baidu/ERNIE-4.5-300B-A47B",
        "name": "baidu/ERNIE-4.5-300B-A47B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.28,
          "output": 1.1
        }
      },
      "stepfun-ai/Step-3.5-Flash": {
        "id": "stepfun-ai/Step-3.5-Flash",
        "name": "stepfun-ai/Step-3.5-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "deepseek-ai/DeepSeek-V3": {
        "id": "deepseek-ai/DeepSeek-V3",
        "name": "deepseek-ai/DeepSeek-V3",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "deepseek-ai/DeepSeek-V4-Flash": {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.028
        }
      },
      "deepseek-ai/DeepSeek-V3.1": {
        "id": "deepseek-ai/DeepSeek-V3.1",
        "name": "deepseek-ai/DeepSeek-V3.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 1
        }
      },
      "deepseek-ai/DeepSeek-V3.1-Terminus": {
        "id": "deepseek-ai/DeepSeek-V3.1-Terminus",
        "name": "deepseek-ai/DeepSeek-V3.1-Terminus",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 1
        }
      },
      "deepseek-ai/DeepSeek-V3.2-Exp": {
        "id": "deepseek-ai/DeepSeek-V3.2-Exp",
        "name": "deepseek-ai/DeepSeek-V3.2-Exp",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-10",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 0.41
        }
      },
      "deepseek-ai/DeepSeek-R1": {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "deepseek-ai/DeepSeek-R1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.5,
          "output": 2.18
        }
      },
      "deepseek-ai/DeepSeek-V3.2": {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "deepseek-ai/DeepSeek-V3.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-03",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 0.42
        }
      },
      "deepseek-ai/DeepSeek-V4-Pro": {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 1.74,
          "output": 3.48,
          "cache_read": 0.145
        }
      },
      "inclusionAI/Ling-flash-2.0": {
        "id": "inclusionAI/Ling-flash-2.0",
        "name": "inclusionAI/Ling-flash-2.0",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "google/gemma-4-31B-it": {
        "id": "google/gemma-4-31B-it",
        "name": "Gemma 4 31B IT",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.13,
          "output": 0.4
        }
      },
      "google/gemma-4-26B-A4B-it": {
        "id": "google/gemma-4-26B-A4B-it",
        "name": "Gemma 4 26B A4B IT",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.12,
          "output": 0.4
        }
      },
      "zai-org/GLM-5.1": {
        "id": "zai-org/GLM-5.1",
        "name": "zai-org/GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 205000,
          "output": 205000
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "zai-org/GLM-5V-Turbo": {
        "id": "zai-org/GLM-5V-Turbo",
        "name": "zai-org/GLM-5V-Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-01",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 1.2,
          "output": 4,
          "cache_read": 0.24,
          "cache_write": 0
        }
      },
      "zai-org/GLM-4.5-Air": {
        "id": "zai-org/GLM-4.5-Air",
        "name": "zai-org/GLM-4.5-Air",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.86
        }
      },
      "zai-org/GLM-5.2": {
        "id": "zai-org/GLM-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1049000,
          "output": 262000
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "zai-org/GLM-5": {
        "id": "zai-org/GLM-5",
        "name": "zai-org/GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 205000,
          "output": 205000
        },
        "cost": {
          "input": 0.95,
          "output": 2.55,
          "cache_read": 0.2
        }
      },
      "Qwen/Qwen3-30B-A3B-Instruct-2507": {
        "id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "name": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.09,
          "output": 0.3
        }
      },
      "Qwen/Qwen3-VL-30B-A3B-Thinking": {
        "id": "Qwen/Qwen3-VL-30B-A3B-Thinking",
        "name": "Qwen/Qwen3-VL-30B-A3B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.29,
          "output": 1
        }
      },
      "Qwen/Qwen3.5-27B": {
        "id": "Qwen/Qwen3.5-27B",
        "name": "Qwen3.5 27B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.25,
          "output": 2
        }
      },
      "Qwen/Qwen3-8B": {
        "id": "Qwen/Qwen3-8B",
        "name": "Qwen/Qwen3-8B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.06,
          "output": 0.06
        }
      },
      "Qwen/Qwen3-VL-32B-Thinking": {
        "id": "Qwen/Qwen3-VL-32B-Thinking",
        "name": "Qwen/Qwen3-VL-32B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.2,
          "output": 1.5
        }
      },
      "Qwen/Qwen3-14B": {
        "id": "Qwen/Qwen3-14B",
        "name": "Qwen/Qwen3-14B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.07,
          "output": 0.28
        }
      },
      "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
        "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "name": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.07,
          "output": 0.28
        }
      },
      "Qwen/Qwen3.5-9B": {
        "id": "Qwen/Qwen3.5-9B",
        "name": "Qwen/Qwen3.5-9B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.1,
          "output": 0.15
        }
      },
      "Qwen/Qwen3.5-122B-A10B": {
        "id": "Qwen/Qwen3.5-122B-A10B",
        "name": "Qwen3.5 122B-A10B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.26,
          "output": 2.08
        }
      },
      "Qwen/Qwen3-VL-235B-A22B-Instruct": {
        "id": "Qwen/Qwen3-VL-235B-A22B-Instruct",
        "name": "Qwen/Qwen3-VL-235B-A22B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.3,
          "output": 1.5
        }
      },
      "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
        "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "name": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "Qwen/Qwen2.5-7B-Instruct": {
        "id": "Qwen/Qwen2.5-7B-Instruct",
        "name": "Qwen/Qwen2.5-7B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 33000,
          "output": 4000
        },
        "cost": {
          "input": 0.05,
          "output": 0.05
        }
      },
      "Qwen/Qwen2.5-72B-Instruct": {
        "id": "Qwen/Qwen2.5-72B-Instruct",
        "name": "Qwen/Qwen2.5-72B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 33000,
          "output": 4000
        },
        "cost": {
          "input": 0.59,
          "output": 0.59
        }
      },
      "Qwen/Qwen3.5-397B-A17B": {
        "id": "Qwen/Qwen3.5-397B-A17B",
        "name": "Qwen3.5 397B-A17B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.39,
          "output": 2.34
        }
      },
      "Qwen/Qwen3.5-35B-A3B": {
        "id": "Qwen/Qwen3.5-35B-A3B",
        "name": "Qwen3.5 35B-A3B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.24,
          "output": 1.8
        }
      },
      "Qwen/Qwen3-VL-32B-Instruct": {
        "id": "Qwen/Qwen3-VL-32B-Instruct",
        "name": "Qwen/Qwen3-VL-32B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.2,
          "output": 0.6
        }
      },
      "Qwen/Qwen3-32B": {
        "id": "Qwen/Qwen3-32B",
        "name": "Qwen/Qwen3-32B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "Qwen/Qwen3-235B-A22B-Thinking-2507": {
        "id": "Qwen/Qwen3-235B-A22B-Thinking-2507",
        "name": "Qwen/Qwen3-235B-A22B-Thinking-2507",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.13,
          "output": 0.6
        }
      },
      "Qwen/Qwen3.6-27B": {
        "id": "Qwen/Qwen3.6-27B",
        "name": "Qwen3.6 27B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-22",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.3,
          "output": 3.2
        }
      },
      "Qwen/Qwen3-VL-8B-Instruct": {
        "id": "Qwen/Qwen3-VL-8B-Instruct",
        "name": "Qwen/Qwen3-VL-8B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.18,
          "output": 0.68
        }
      },
      "Qwen/Qwen3.6-35B-A3B": {
        "id": "Qwen/Qwen3.6-35B-A3B",
        "name": "Qwen3.6 35B-A3B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-17",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.2,
          "output": 1.6
        }
      },
      "Qwen/Qwen3-VL-235B-A22B-Thinking": {
        "id": "Qwen/Qwen3-VL-235B-A22B-Thinking",
        "name": "Qwen/Qwen3-VL-235B-A22B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.45,
          "output": 3.5
        }
      },
      "Qwen/Qwen3-VL-30B-A3B-Instruct": {
        "id": "Qwen/Qwen3-VL-30B-A3B-Instruct",
        "name": "Qwen/Qwen3-VL-30B-A3B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.29,
          "output": 1
        }
      },
      "ByteDance-Seed/Seed-OSS-36B-Instruct": {
        "id": "ByteDance-Seed/Seed-OSS-36B-Instruct",
        "name": "ByteDance-Seed/Seed-OSS-36B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.21,
          "output": 0.57
        }
      },
      "MiniMaxAI/MiniMax-M2.5": {
        "id": "MiniMaxAI/MiniMax-M2.5",
        "name": "MiniMaxAI/MiniMax-M2.5",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 197000,
          "output": 131000
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03
        }
      },
      "openai/gpt-oss-20b": {
        "id": "openai/gpt-oss-20b",
        "name": "openai/gpt-oss-20b",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 8000
        },
        "cost": {
          "input": 0.04,
          "output": 0.18
        }
      },
      "openai/gpt-oss-120b": {
        "id": "openai/gpt-oss-120b",
        "name": "openai/gpt-oss-120b",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 8000
        },
        "cost": {
          "input": 0.05,
          "output": 0.45
        }
      },
      "moonshotai/Kimi-K2.5": {
        "id": "moonshotai/Kimi-K2.5",
        "name": "moonshotai/Kimi-K2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-27",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.45,
          "output": 2.25,
          "cache_read": 0.07
        }
      },
      "moonshotai/Kimi-K2.6": {
        "id": "moonshotai/Kimi-K2.6",
        "name": "moonshotai/Kimi-K2.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.77,
          "output": 4,
          "cache_read": 0.2
        }
      },
      "tencent/Hunyuan-A13B-Instruct": {
        "id": "tencent/Hunyuan-A13B-Instruct",
        "name": "tencent/Hunyuan-A13B-Instruct",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "tencent/Hy3-preview": {
        "id": "tencent/Hy3-preview",
        "name": "Hy3 preview",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-04-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0.066,
          "output": 0.26,
          "cache_read": 0.029
        }
      }
    }
  },
  "siliconflow-cn": {
    "name": "SiliconFlow (China)",
    "api": "https://api.siliconflow.cn/v1",
    "doc": "https://cloud.siliconflow.com/models",
    "env": [
      "SILICONFLOW_CN_API_KEY"
    ],
    "models": {
      "baidu/ERNIE-4.5-300B-A47B": {
        "id": "baidu/ERNIE-4.5-300B-A47B",
        "name": "baidu/ERNIE-4.5-300B-A47B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.28,
          "output": 1.1
        }
      },
      "stepfun-ai/Step-3.5-Flash": {
        "id": "stepfun-ai/Step-3.5-Flash",
        "name": "stepfun-ai/Step-3.5-Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3
        }
      },
      "deepseek-ai/DeepSeek-V4-Flash": {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.003
        }
      },
      "deepseek-ai/DeepSeek-V3.1-Terminus": {
        "id": "deepseek-ai/DeepSeek-V3.1-Terminus",
        "name": "deepseek-ai/DeepSeek-V3.1-Terminus",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 1
        }
      },
      "deepseek-ai/DeepSeek-OCR": {
        "id": "deepseek-ai/DeepSeek-OCR",
        "name": "deepseek-ai/DeepSeek-OCR",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-20",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 8192
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "deepseek-ai/DeepSeek-R1": {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "deepseek-ai/DeepSeek-R1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.5,
          "output": 2.18
        }
      },
      "deepseek-ai/DeepSeek-V3.2": {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "deepseek-ai/DeepSeek-V3.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-03",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 0.42
        }
      },
      "deepseek-ai/DeepSeek-V4-Pro": {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "deepseek-ai/DeepSeek-V4-Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1049000,
          "output": 393000
        },
        "cost": {
          "input": 1.74,
          "output": 3.48,
          "cache_read": 0.145
        }
      },
      "deepseek-ai/DeepSeek-V3": {
        "id": "deepseek-ai/DeepSeek-V3",
        "name": "deepseek-ai/DeepSeek-V3",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "inclusionAI/Ling-flash-2.0": {
        "id": "inclusionAI/Ling-flash-2.0",
        "name": "inclusionAI/Ling-flash-2.0",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "zai-org/GLM-5.2": {
        "id": "zai-org/GLM-5.2",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1049000,
          "output": 262000
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "zai-org/GLM-4.5-Air": {
        "id": "zai-org/GLM-4.5-Air",
        "name": "zai-org/GLM-4.5-Air",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.86
        }
      },
      "Qwen/Qwen3.5-27B": {
        "id": "Qwen/Qwen3.5-27B",
        "name": "Qwen/Qwen3.5-27B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-25",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.26,
          "output": 2.09
        }
      },
      "Qwen/Qwen3-8B": {
        "id": "Qwen/Qwen3-8B",
        "name": "Qwen/Qwen3-8B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.06,
          "output": 0.06
        }
      },
      "Qwen/Qwen3-14B": {
        "id": "Qwen/Qwen3-14B",
        "name": "Qwen/Qwen3-14B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.07,
          "output": 0.28
        }
      },
      "Qwen/Qwen3.5-4B": {
        "id": "Qwen/Qwen3.5-4B",
        "name": "Qwen/Qwen3.5-4B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "Qwen/Qwen3.5-9B": {
        "id": "Qwen/Qwen3.5-9B",
        "name": "Qwen/Qwen3.5-9B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-03",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.22,
          "output": 1.74
        }
      },
      "Qwen/Qwen3.5-122B-A10B": {
        "id": "Qwen/Qwen3.5-122B-A10B",
        "name": "Qwen/Qwen3.5-122B-A10B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.29,
          "output": 2.32
        }
      },
      "Qwen/Qwen3.5-397B-A17B": {
        "id": "Qwen/Qwen3.5-397B-A17B",
        "name": "Qwen/Qwen3.5-397B-A17B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.29,
          "output": 1.74
        }
      },
      "Qwen/Qwen3.5-35B-A3B": {
        "id": "Qwen/Qwen3.5-35B-A3B",
        "name": "Qwen/Qwen3.5-35B-A3B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-25",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.23,
          "output": 1.86
        }
      },
      "Qwen/Qwen3-32B": {
        "id": "Qwen/Qwen3-32B",
        "name": "Qwen/Qwen3-32B",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-04-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "Qwen/Qwen3-235B-A22B-Thinking-2507": {
        "id": "Qwen/Qwen3-235B-A22B-Thinking-2507",
        "name": "Qwen/Qwen3-235B-A22B-Thinking-2507",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.13,
          "output": 0.6
        }
      },
      "Qwen/Qwen3.6-35B-A3B": {
        "id": "Qwen/Qwen3.6-35B-A3B",
        "name": "Qwen/Qwen3.6-35B-A3B",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 65536
        },
        "cost": {
          "input": 0.23,
          "output": 1.86
        }
      },
      "Qwen/Qwen3-VL-30B-A3B-Instruct": {
        "id": "Qwen/Qwen3-VL-30B-A3B-Instruct",
        "name": "Qwen/Qwen3-VL-30B-A3B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-05",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.29,
          "output": 1
        }
      },
      "Qwen/Qwen3-VL-235B-A22B-Thinking": {
        "id": "Qwen/Qwen3-VL-235B-A22B-Thinking",
        "name": "Qwen/Qwen3-VL-235B-A22B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.45,
          "output": 3.5
        }
      },
      "Qwen/Qwen3-VL-8B-Instruct": {
        "id": "Qwen/Qwen3-VL-8B-Instruct",
        "name": "Qwen/Qwen3-VL-8B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.18,
          "output": 0.68
        }
      },
      "Qwen/Qwen3-VL-32B-Instruct": {
        "id": "Qwen/Qwen3-VL-32B-Instruct",
        "name": "Qwen/Qwen3-VL-32B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.2,
          "output": 0.6
        }
      },
      "Qwen/Qwen2.5-72B-Instruct": {
        "id": "Qwen/Qwen2.5-72B-Instruct",
        "name": "Qwen/Qwen2.5-72B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 33000,
          "output": 4000
        },
        "cost": {
          "input": 0.59,
          "output": 0.59
        }
      },
      "Qwen/Qwen2.5-7B-Instruct": {
        "id": "Qwen/Qwen2.5-7B-Instruct",
        "name": "Qwen/Qwen2.5-7B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-09-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 33000,
          "output": 4000
        },
        "cost": {
          "input": 0.05,
          "output": 0.05
        }
      },
      "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
        "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "name": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "Qwen/Qwen3-VL-235B-A22B-Instruct": {
        "id": "Qwen/Qwen3-VL-235B-A22B-Instruct",
        "name": "Qwen/Qwen3-VL-235B-A22B-Instruct",
        "attachment": true,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.3,
          "output": 1.5
        }
      },
      "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
        "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "name": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.07,
          "output": 0.28
        }
      },
      "Qwen/Qwen3-VL-32B-Thinking": {
        "id": "Qwen/Qwen3-VL-32B-Thinking",
        "name": "Qwen/Qwen3-VL-32B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.2,
          "output": 1.5
        }
      },
      "Qwen/Qwen3-VL-30B-A3B-Thinking": {
        "id": "Qwen/Qwen3-VL-30B-A3B-Thinking",
        "name": "Qwen/Qwen3-VL-30B-A3B-Thinking",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-11",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.29,
          "output": 1
        }
      },
      "Qwen/Qwen3-30B-A3B-Instruct-2507": {
        "id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "name": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-07-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.09,
          "output": 0.3
        }
      },
      "ByteDance-Seed/Seed-OSS-36B-Instruct": {
        "id": "ByteDance-Seed/Seed-OSS-36B-Instruct",
        "name": "ByteDance-Seed/Seed-OSS-36B-Instruct",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.21,
          "output": 0.57
        }
      },
      "Pro/deepseek-ai/DeepSeek-V3": {
        "id": "Pro/deepseek-ai/DeepSeek-V3",
        "name": "Pro/deepseek-ai/DeepSeek-V3",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2024-12-26",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.25,
          "output": 1
        }
      },
      "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": {
        "id": "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
        "name": "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-09-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 1
        }
      },
      "Pro/deepseek-ai/DeepSeek-R1": {
        "id": "Pro/deepseek-ai/DeepSeek-R1",
        "name": "Pro/deepseek-ai/DeepSeek-R1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-05-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.5,
          "output": 2.18
        }
      },
      "Pro/deepseek-ai/DeepSeek-V3.2": {
        "id": "Pro/deepseek-ai/DeepSeek-V3.2",
        "name": "Pro/deepseek-ai/DeepSeek-V3.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-03",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 164000,
          "output": 164000
        },
        "cost": {
          "input": 0.27,
          "output": 0.42
        }
      },
      "Pro/zai-org/GLM-5.1": {
        "id": "Pro/zai-org/GLM-5.1",
        "name": "Pro/zai-org/GLM-5.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-08",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 205000,
          "output": 205000
        },
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26,
          "cache_write": 0
        }
      },
      "Pro/zai-org/GLM-5": {
        "id": "Pro/zai-org/GLM-5",
        "name": "Pro/zai-org/GLM-5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 205000,
          "output": 205000
        },
        "cost": {
          "input": 1,
          "output": 3.2
        }
      },
      "Pro/MiniMaxAI/MiniMax-M2.5": {
        "id": "Pro/MiniMaxAI/MiniMax-M2.5",
        "name": "Pro/MiniMaxAI/MiniMax-M2.5",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 192000,
          "output": 131000
        },
        "cost": {
          "input": 0.3,
          "output": 1.22
        }
      },
      "Pro/moonshotai/Kimi-K2.5": {
        "id": "Pro/moonshotai/Kimi-K2.5",
        "name": "Pro/moonshotai/Kimi-K2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-27",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.45,
          "output": 2.25,
          "cache_read": 0.07
        }
      },
      "Pro/moonshotai/Kimi-K2.6": {
        "id": "Pro/moonshotai/Kimi-K2.6",
        "name": "Pro/moonshotai/Kimi-K2.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-21",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262000,
          "output": 262000
        },
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      "tencent/Hunyuan-A13B-Instruct": {
        "id": "tencent/Hunyuan-A13B-Instruct",
        "name": "tencent/Hunyuan-A13B-Instruct",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-06-30",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131000,
          "output": 131000
        },
        "cost": {
          "input": 0.14,
          "output": 0.57
        }
      },
      "PaddlePaddle/PaddleOCR-VL-1.5": {
        "id": "PaddlePaddle/PaddleOCR-VL-1.5",
        "name": "PaddlePaddle/PaddleOCR-VL-1.5",
        "attachment": true,
        "reasoning": false,
        "toolCall": false,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 16384
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      }
    }
  },
  "minimax": {
    "name": "MiniMax (minimax.io)",
    "api": "https://api.minimax.io/anthropic/v1",
    "doc": "https://platform.minimax.io/docs/guides/quickstart",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "models": {
      "MiniMax-M2": {
        "id": "MiniMax-M2",
        "name": "MiniMax-M2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2
        }
      },
      "MiniMax-M2.1": {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.5": {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.5-highspeed": {
        "id": "MiniMax-M2.5-highspeed",
        "name": "MiniMax-M2.5-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.4,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      },
      "MiniMax-M3": {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      "MiniMax-M2.7-highspeed": {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.4,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.7": {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      }
    }
  },
  "minimax-cn": {
    "name": "MiniMax (minimaxi.com)",
    "api": "https://api.minimaxi.com/anthropic/v1",
    "doc": "https://platform.minimaxi.com/docs/guides/quickstart",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "models": {
      "MiniMax-M2": {
        "id": "MiniMax-M2",
        "name": "MiniMax-M2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2
        }
      },
      "MiniMax-M2.1": {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.5": {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.03,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.5-highspeed": {
        "id": "MiniMax-M2.5-highspeed",
        "name": "MiniMax-M2.5-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.4,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      },
      "MiniMax-M3": {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      "MiniMax-M2.7-highspeed": {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.6,
          "output": 2.4,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      },
      "MiniMax-M2.7": {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      }
    }
  },
  "minimax-coding-plan": {
    "name": "MiniMax Token Plan (minimax.io)",
    "api": "https://api.minimax.io/anthropic/v1",
    "doc": "https://platform.minimax.io/docs/token-plan/intro",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "models": {
      "MiniMax-M2": {
        "id": "MiniMax-M2",
        "name": "MiniMax-M2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "MiniMax-M2.1": {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.5": {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.5-highspeed": {
        "id": "MiniMax-M2.5-highspeed",
        "name": "MiniMax-M2.5-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M3": {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.7-highspeed": {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.7": {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "minimax-cn-coding-plan": {
    "name": "MiniMax Token Plan (minimaxi.com)",
    "api": "https://api.minimaxi.com/anthropic/v1",
    "doc": "https://platform.minimaxi.com/docs/token-plan/intro",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "models": {
      "MiniMax-M2": {
        "id": "MiniMax-M2",
        "name": "MiniMax-M2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-10-27",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "MiniMax-M2.1": {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2025-12-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.5": {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.5-highspeed": {
        "id": "MiniMax-M2.5-highspeed",
        "name": "MiniMax-M2.5-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-02-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M3": {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.7-highspeed": {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "MiniMax-M2.7": {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-03-18",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 204800,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      }
    }
  },
  "volcengine": {
    "name": "Volcengine Ark",
    "api": "https://ark.cn-beijing.volces.com/api/v3",
    "doc": "https://www.volcengine.com/docs/82379/1330310",
    "env": [
      "ARK_API_KEY"
    ],
    "models": {
      "doubao-seed-2-0-lite-260428": {
        "id": "doubao-seed-2-0-lite-260428",
        "name": "Seed 2.0 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 131072
        },
        "cost": {
          "input": 0.08906,
          "output": 0.53436,
          "cache_read": 0.01781
        }
      },
      "doubao-seed-character-260628": {
        "id": "doubao-seed-character-260628",
        "name": "Seed Character",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.11875,
          "output": 0.29687,
          "cache_read": 0.02375
        }
      },
      "doubao-seed-2-0-mini-260428": {
        "id": "doubao-seed-2-0-mini-260428",
        "name": "Seed 2.0 Mini",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 131072
        },
        "cost": {
          "input": 0.02969,
          "output": 0.29687,
          "cache_read": 0.00594
        }
      },
      "doubao-seed-2-1-pro-260628": {
        "id": "doubao-seed-2-1-pro-260628",
        "name": "Seed 2.1 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.8906,
          "output": 4.45301,
          "cache_read": 0.17812
        }
      },
      "doubao-seed-2-0-code-preview-260215": {
        "id": "doubao-seed-2-0-code-preview-260215",
        "name": "Seed 2.0 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 131072
        },
        "cost": {
          "input": 0.47499,
          "output": 2.37494,
          "cache_read": 0.095
        }
      },
      "doubao-seed-1-8-251228": {
        "id": "doubao-seed-1-8-251228",
        "name": "Seed 1.8",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-12-28",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 64000
        },
        "cost": {
          "input": 0.11875,
          "output": 1.18747,
          "cache_read": 0.02375
        }
      },
      "doubao-seed-1-6-flash-250828": {
        "id": "doubao-seed-1-6-flash-250828",
        "name": "Seed 1.6 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-28",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 32000
        },
        "cost": {
          "input": 0.02227,
          "output": 0.22265,
          "cache_read": 0.00445
        }
      },
      "doubao-seed-1-6-251015": {
        "id": "doubao-seed-1-6-251015",
        "name": "Seed 1.6",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-10-15",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 64000
        },
        "cost": {
          "input": 0.11875,
          "output": 1.18747,
          "cache_read": 0.02375
        }
      },
      "deepseek-v4-pro-ga-260813": {
        "id": "deepseek-v4-pro-ga-260813",
        "name": "DeepSeek V4 Pro 0813",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-12",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 1.3359,
          "output": 4.00771,
          "cache_read": 0.04453
        }
      },
      "doubao-seed-evolving": {
        "id": "doubao-seed-evolving",
        "name": "Seed Evolving",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.8906,
          "output": 4.45301,
          "cache_read": 0.17812
        }
      },
      "doubao-seed-2-0-pro-260215": {
        "id": "doubao-seed-2-0-pro-260215",
        "name": "Seed 2.0 Pro",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 128000
        },
        "cost": {
          "input": 0.47499,
          "output": 2.37494,
          "cache_read": 0.095
        }
      },
      "doubao-seed-1-6-vision-250815": {
        "id": "doubao-seed-1-6-vision-250815",
        "name": "Seed 1.6 Vision",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-08-15",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 32000
        },
        "cost": {
          "input": 0.11875,
          "output": 1.18747,
          "cache_read": 0.02375
        }
      },
      "glm-5-2-260617": {
        "id": "glm-5-2-260617",
        "name": "GLM-5.2",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 1.18747,
          "output": 4.15615,
          "cache_read": 0.29687
        }
      },
      "doubao-seed-2-1-turbo-260628": {
        "id": "doubao-seed-2-1-turbo-260628",
        "name": "Seed 2.1 Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.4453,
          "output": 2.22651,
          "cache_read": 0.08906
        }
      },
      "glm-5-3-flash-260828": {
        "id": "glm-5-3-flash-260828",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.11875,
          "output": 0.41563,
          "cache_read": 0.03414
        }
      },
      "deepseek-v4-flash-ga-260731": {
        "id": "deepseek-v4-flash-ga-260731",
        "name": "DeepSeek V4 Flash 0731",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0.4453,
          "output": 1.3359,
          "cache_read": 0.01484
        }
      }
    }
  },
  "volcengine-coding-plan": {
    "name": "Volcengine Ark Coding Plan",
    "api": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "doc": "https://www.volcengine.com/docs/82379/1928261",
    "env": [
      "ARK_CODING_PLAN_API_KEY"
    ],
    "models": {
      "doubao-seed-2.1-turbo": {
        "id": "doubao-seed-2.1-turbo",
        "name": "Seed 2.1 Turbo",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "minimax-m3": {
        "id": "minimax-m3",
        "name": "MiniMax-M3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-06-01",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 512000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "deepseek-v4-flash": {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "kimi-k2.7-code": {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-06-12",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 262144
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "kimi-k3": {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": false,
        "openWeights": true,
        "releaseDate": "2026-07-16",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "doubao-seed-evolving": {
        "id": "doubao-seed-evolving",
        "name": "Seed Evolving",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-06-23",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "deepseek-v4-pro": {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 384000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "doubao-seed-2.0-lite": {
        "id": "doubao-seed-2.0-lite",
        "name": "Seed 2.0 Lite",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-02-14",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 32000
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      "glm-5.3": {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "structuredOutput": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-08-14",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      }
    }
  },
  "stepfun": {
    "name": "StepFun (China)",
    "api": "https://api.stepfun.com/v1",
    "doc": "https://platform.stepfun.com/docs/zh/overview/concept",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "models": {
      "step-3.7-flash": {
        "id": "step-3.7-flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.185,
          "output": 1.11,
          "cache_read": 0.037
        }
      },
      "step-tts-2": {
        "id": "step-tts-2",
        "name": "Step TTS 2",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-3.5-flash": {
        "id": "step-3.5-flash",
        "name": "Step 3.5 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3,
          "cache_read": 0.02
        }
      },
      "step-2-16k": {
        "id": "step-2-16k",
        "name": "Step 2 (16K)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-01-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 8192
        },
        "cost": {
          "input": 5.21,
          "output": 16.44,
          "cache_read": 1.04
        }
      },
      "stepaudio-2.5-asr": {
        "id": "stepaudio-2.5-asr",
        "name": "StepAudio 2.5 ASR",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-3.5-flash-2603": {
        "id": "step-3.5-flash-2603",
        "name": "Step 3.5 Flash 2603",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3,
          "cache_read": 0.02
        }
      },
      "stepaudio-2.5-tts": {
        "id": "stepaudio-2.5-tts",
        "name": "StepAudio 2.5 TTS",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-1-32k": {
        "id": "step-1-32k",
        "name": "Step 1 (32K)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-01-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 32768
        },
        "cost": {
          "input": 2.05,
          "output": 9.59,
          "cache_read": 0.41
        }
      }
    }
  },
  "stepfun-ai": {
    "name": "StepFun (Global)",
    "api": "https://api.stepfun.ai/v1",
    "doc": "https://platform.stepfun.ai/docs/en/overview/concept",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "models": {
      "step-1-32k": {
        "id": "step-1-32k",
        "name": "Step 1 (32K)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-01-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 32768
        },
        "cost": {
          "input": 2.05,
          "output": 9.59,
          "cache_read": 0.41
        }
      },
      "stepaudio-2.5-tts": {
        "id": "stepaudio-2.5-tts",
        "name": "StepAudio 2.5 TTS",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-16",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-3.5-flash-2603": {
        "id": "step-3.5-flash-2603",
        "name": "Step 3.5 Flash 2603",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3,
          "cache_read": 0.02
        }
      },
      "stepaudio-2.5-asr": {
        "id": "stepaudio-2.5-asr",
        "name": "StepAudio 2.5 ASR",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-04-24",
        "modalities": {
          "input": [
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-2-16k": {
        "id": "step-2-16k",
        "name": "Step 2 (16K)",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2025-01-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 16384,
          "output": 8192
        },
        "cost": {
          "input": 5.21,
          "output": 16.44,
          "cache_read": 1.04
        }
      },
      "step-3.5-flash": {
        "id": "step-3.5-flash",
        "name": "Step 3.5 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.1,
          "output": 0.3,
          "cache_read": 0.02
        }
      },
      "step-tts-2": {
        "id": "step-tts-2",
        "name": "Step TTS 2",
        "attachment": false,
        "reasoning": false,
        "toolCall": false,
        "temperature": false,
        "openWeights": false,
        "releaseDate": "2026-03-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "audio"
          ]
        },
        "limit": {
          "context": 0,
          "output": 0
        }
      },
      "step-3.7-flash": {
        "id": "step-3.7-flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        },
        "cost": {
          "input": 0.185,
          "output": 1.11,
          "cache_read": 0.037
        }
      }
    }
  },
  "stepfun-step-plan": {
    "name": "StepFun Step Plan (China)",
    "api": "https://api.stepfun.com/step_plan/v1",
    "doc": "https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "models": {
      "step-3.7-flash": {
        "id": "step-3.7-flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      },
      "step-3.5-flash": {
        "id": "step-3.5-flash",
        "name": "Step 3.5 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      },
      "step-3.5-flash-2603": {
        "id": "step-3.5-flash-2603",
        "name": "Step 3.5 Flash 2603",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      },
      "step-router-v1": {
        "id": "step-router-v1",
        "name": "Step Router v1",
        "attachment": false,
        "reasoning": false,
        "toolCall": true,
        "temperature": true,
        "openWeights": false,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      }
    }
  },
  "stepfun-ai-step-plan": {
    "name": "StepFun Step Plan (Global)",
    "api": "https://api.stepfun.ai/step_plan/v1",
    "doc": "https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "models": {
      "step-3.7-flash": {
        "id": "step-3.7-flash",
        "name": "Step 3.7 Flash",
        "attachment": true,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-05-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      },
      "step-3.5-flash": {
        "id": "step-3.5-flash",
        "name": "Step 3.5 Flash",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-01-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      },
      "step-3.5-flash-2603": {
        "id": "step-3.5-flash-2603",
        "name": "Step 3.5 Flash 2603",
        "attachment": false,
        "reasoning": true,
        "toolCall": true,
        "temperature": true,
        "openWeights": true,
        "releaseDate": "2026-04-02",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 256000
        }
      }
    }
  }
};
