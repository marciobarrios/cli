const crypto = require('crypto');
const _ = require('lodash');
const base32 = require('base32');
const inquirer = require('inquirer');
const npm = require('npm');
const request = require('request-promise').defaults({resolveWithFullResponse: true});
const validator = require('validator');
const log = require('npmlog');
const gitConfigPath = require('git-config-path')('global');
const parse = require('parse-git-config');

async function ask2FA() {
  return (await inquirer.prompt([
    {
      type: 'input',
      name: 'code',
      message: 'What is your GitHub two-factor authentication code?',
      validate: validator.isNumeric,
    },
  ])).code;
}

function randomId() {
  return base32.encode(crypto.randomBytes(4));
}

async function createAuthorization(info) {
  const reponame = info.ghrepo && info.ghrepo.slug[1];
  const node = (reponame ? `-${reponame}-` : '-') + randomId();

  try {
    const response = await request({
      method: 'POST',
      url: `${info.github.endpoint}/authorizations`,
      json: true,
      auth: info.github,
      headers: {'User-Agent': 'semantic-release', 'X-GitHub-OTP': info.github.code},
      body: {
        scopes: [
          'repo',
          'read:org',
          'user:email',
          'repo_deployment',
          'repo:status',
          'write:repo_hook',
          'write:packages',
          'read:packages',
        ],
        note: `semantic-release${node}`,
      },
    });
    if (response.statusCode === 201) return response.body.token;
  } catch (error) {
    if (error.statusCode === 401 && error.response.headers['x-github-otp']) {
      const [, type] = error.response.headers['x-github-otp'].split('; ');

      if (info.github.retry) log.warn('Invalid two-factor authentication code.');
      else log.info(`Two-factor authentication code needed via ${type}.`);

      const code = await ask2FA();
      info.github.code = code;
      info.github.retry = true;
      return createAuthorization(info);
    }

    throw error;
  }
}

module.exports = async function(pkg, info) {
  if (_.has(info.options, 'gh-token')) {
    info.github = {
      endpoint: info.ghepurl || 'https://api.github.com',
      token: info.options['gh-token'],
    };
    log.info('Using GitHub token from command line argument.');
    return;
  }

  const githubUserFromGitConfig = parse.sync({path: gitConfigPath}).github
    ? parse.sync({path: gitConfigPath}).github.user
    : null;

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: 'What is your GitHub username?',
      default: info.options['gh-username'] || githubUserFromGitConfig || npm.config.get('username'),
      validate: _.ary(_.bind(validator.isLength, validator, _, 1), 1),
    },
    {
      type: 'password',
      name: 'password',
      message: 'What is your GitHub password?',
      validate: _.ary(_.bind(validator.isLength, validator, _, 1), 1),
    },
  ]);

  info.github = answers;
  info.github.endpoint = info.ghepurl || 'https://api.github.com';

  const token = await createAuthorization(info);

  if (!token) throw new Error('Could not login to GitHub.');

  info.github.token = token;
  log.info('Successfully created GitHub token.');
};
