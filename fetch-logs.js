const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const client = new CloudWatchLogsClient({ region: 'ap-south-1' });
async function run() {
  try {
    const data = await client.send(new GetLogEventsCommand({
      logGroupName: '/ecs/vacapay-backend',
      logStreamName: 'ecs/vacapay-backend/0f5c0217153a4aa0933987a086e56989'
    }));
    data.events.forEach(e => console.log(e.message));
  } catch (err) {
    console.error(err);
  }
}
run();
