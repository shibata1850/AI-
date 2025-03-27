const { App } = require('@slack/bolt');
const { OpenAI } = require('openai');
require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'OPENAI_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Error: Missing required environment variables:');
  missingEnvVars.forEach(envVar => console.error(`- ${envVar}`));
  process.exit(1);
}

// Initialize Slack app with explicit configuration and error handling
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: parseInt(process.env.PORT || '3000', 10),
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200);
        res.end('Health check passed');
      },
    },
  ],
});

// Initialize OpenAI with error handling
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Industry types and their specific templates
const INDUSTRIES = {
  manufacturing: '製造業',
  construction: '建設業',
  retail: '小売業',
  agriculture: '農業',
  service: 'サービス業',
  professional: '士業',
  medical: '医療',
  restaurant: '飲食業'
};

// Business categories
const CATEGORIES = {
  accounting: '経理',
  hr: '人事',
  admin: '総務',
  sales: '営業支援'
};

// Store user contexts (in-memory - replace with proper database in production)
const userContexts = new Map();

// Helper function to generate AI response with error handling
async function generateAIResponse(prompt, industry = null, category = null) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `あなたは${industry || ''}向けの${category || ''}専門アシスタントです。
                   専門的かつ実用的なアドバイスを提供してください。`
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return "申し訳ありません。現在AIの応答に問題が発生しています。";
  }
}

// Home tab view with error handling
async function updateHomeTab(userId) {
  try {
    const userContext = userContexts.get(userId) || {};
    
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Softdoing AI ボード 🤖",
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "業務効率化のためのAIアシスタントへようこそ！\n業種を選択して始めましょう。"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "業種を選択",
              emoji: true
            },
            action_id: "select_industry",
            options: Object.entries(INDUSTRIES).map(([value, text]) => ({
              text: {
                type: "plain_text",
                text: text,
                emoji: true
              },
              value: value
            }))
          }
        ]
      }
    ];

    if (userContext.industry) {
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*選択された業種: ${INDUSTRIES[userContext.industry]}*\n以下のカテゴリから選択してください：`
          }
        },
        {
          type: "actions",
          elements: Object.entries(CATEGORIES).map(([value, text]) => ({
            type: "button",
            text: {
              type: "plain_text",
              text: text,
              emoji: true
            },
            value: value,
            action_id: `category_${value}`
          }))
        }
      );
    }

    await app.client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error updating home tab:', error);
  }
}

// Handle industry selection with error handling
app.action('select_industry', async ({ ack, body, client }) => {
  try {
    await ack();
    
    const userId = body.user.id;
    const selectedIndustry = body.actions[0].selected_option.value;
    
    userContexts.set(userId, {
      ...userContexts.get(userId),
      industry: selectedIndustry
    });
    
    await updateHomeTab(userId);
  } catch (error) {
    console.error('Error handling industry selection:', error);
  }
});

// Handle category selection with error handling
Object.keys(CATEGORIES).forEach(category => {
  app.action(`category_${category}`, async ({ ack, body, client }) => {
    try {
      await ack();
      
      const userContext = userContexts.get(body.user.id);
      if (!userContext || !userContext.industry) return;

      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: "modal_submit",
          title: {
            type: "plain_text",
            text: `${CATEGORIES[category]}サポート`,
            emoji: true
          },
          submit: {
            type: "plain_text",
            text: "送信",
            emoji: true
          },
          close: {
            type: "plain_text",
            text: "キャンセル",
            emoji: true
          },
          blocks: [
            {
              type: "input",
              block_id: "query_block",
              element: {
                type: "plain_text_input",
                action_id: "query_input",
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "ご質問や依頼内容を入力してください"
                }
              },
              label: {
                type: "plain_text",
                text: "質問内容",
                emoji: true
              }
            }
          ],
          private_metadata: JSON.stringify({
            industry: userContext.industry,
            category: category
          })
        }
      });
    } catch (error) {
      console.error('Error opening modal:', error);
    }
  });
});

// Handle modal submission with error handling
app.view('modal_submit', async ({ ack, body, view, client }) => {
  try {
    await ack();

    const { industry, category } = JSON.parse(view.private_metadata);
    const query = view.state.values.query_block.query_input.value;
    const userId = body.user.id;

    const response = await generateAIResponse(query, INDUSTRIES[industry], CATEGORIES[category]);
    
    await client.chat.postMessage({
      channel: userId,
      text: response,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${INDUSTRIES[industry]} - ${CATEGORIES[category]}に関する回答*\n\n${response}`
          }
        }
      ]
    });
  } catch (error) {
    console.error('Error handling modal submission:', error);
  }
});

// Slash command handler with error handling
app.command('/ai-board', async ({ command, ack, respond }) => {
  try {
    await ack();
    
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "AIボードを起動しました。以下から業種を選択してください："
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "業種を選択",
              emoji: true
            },
            action_id: "command_select_industry",
            options: Object.entries(INDUSTRIES).map(([value, text]) => ({
              text: {
                type: "plain_text",
                text: text,
                emoji: true
              },
              value: value
            }))
          }
        ]
      }
    ];

    await respond({
      blocks: blocks,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error handling slash command:', error);
  }
});

// Event handler for app_home_opened with error handling
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await updateHomeTab(event.user);
  } catch (error) {
    console.error('Error handling app_home_opened event:', error);
  }
});

// Error handler for unhandled errors
app.error(async (error) => {
  console.error('Global error handler:', error);
});

// Start the app with error handling
(async () => {
  try {
    await app.start();
    console.log('⚡️ Bolt app is running!');
  } catch (error) {
    console.error('Error starting Bolt app:', error);
    process.exit(1);
  }
})();