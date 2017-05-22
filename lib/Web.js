const express = require('express');
const bodyParser = require('body-parser');
const ChannelConfig = require('./Models/ChannelConfig');
const GitlabEventHandler = require('./Gitlab/EventHandler');
const bot = require('./Discord');

const app = express();
const port = process.env.YAPPY_GITLAB_PORT || process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || 8080;
const ip = process.env.YAPPY_GITLAB_IP || process.env.OPENSHIFT_NODEJS_IP || process.env.IP || null;
const statuses = ['Online', 'Connecting', 'Reconnecting', 'Idle', 'Nearly', 'Offline'];
const statusColors = ['lightgreen', 'orange', 'orange', 'orange', 'green', 'red'];

app.set('view engine', 'hbs');

app.use(bodyParser.json({
  limit: '250kb',
}));

app.get('/', (req, res) => {
  const repos = new Set(ChannelConfig._data.reduce((a, b) => a.concat(b.repos), []));
  const status = statuses[bot.status];
  const statusColor = statusColors[bot.status];
  res.render('index', { bot, repos, status, statusColor });
});

app.post('/', (req, res) => {
  const event = req.headers['x-gitlab-event'];
  const eventName = event && event.replace(` Hook`, '').replace(/ /g, '_').toLowerCase();
  const data = req.body;

  if (!event || !data || !data.project) return res.status(403).send('Invalid data. Plz use Gitlab webhooks.');

  const repo = data.project.path_with_namespace;
  const channels = ChannelConfig.FindByRepo(repo);
  const actionText = data.object_attributes && data.object_attributes.action ? `/${data.object_attributes.action}` : '';
  Log.verbose(`GitLab | ${repo} - ${eventName}${actionText} (${channels.size} channels)`);
  res.send(`${repo} : Received ${eventName}${actionText}, emitting to ${channels.size} channels...`);
  const eventResponse = GitlabEventHandler.use(data, event);

  const handleError = (resp, channel) => {
    const err = resp && resp.body;
    const errors = ['Forbidden', 'Missing Access'];
    if (!res || !err) return;
    if (errors.includes(err.message) || (err.error && errors.includes(err.error.message))) {
      channel.guild.owner.send(`**ERROR:** Yappy GitLab doesn't have permissions to read/send messages in ${channel}`);
    } else {
      channel.guild.owner.send([
        `**ERROR:** An error occurred when trying to read/send messages in ${channel}.`,
        'Please report this to the bot\'s developer\n',
        '```js\n',
        err,
        '\n```',
      ].join(' '));
      Log.error(err);
    }
  };

  channels.forEach(conf => {
    const wantsEmbed = !!conf.embed;
    const { channelID, disabledEvents, ignoredUsers, ignoredBranches } = conf;
    const channel = bot.channels.get(channelID);
    const actor = {
      name: data.user ? data.user.name : data.user_name,
      id: data.user ? data.user.id : data.user_id,
    };
    const branch = data.ref && data.ref ? data.ref.split('/')[2] : data.object_attributes.ref;
    if (!channel) return;
    if (disabledEvents.includes(event) || disabledEvents.includes(`${event}${actionText}`)) return;
    if (ignoredUsers && (ignoredUsers.includes(actor.name) || ignoredUsers.includes(actor.id))) return;
    if (ignoredBranches && branch && ignoredBranches.includes(branch)) return;

    if (wantsEmbed) {
      channel.send({ embed: eventResponse.embed }).catch(err => handleError(err, channel));
    } else {
      channel.send(`**${repo}**: ${eventResponse.text}`).catch(err => handleError(err, channel));
    }
  });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err) Log.error(err);
  res.status(500);
  res.send(err.stack);
});

app.listen(port, ip, () => {
  Log.info(`Express | Listening on ${ip || 'localhost'}:${port}`);
});

module.exports = app;