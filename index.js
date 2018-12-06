// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more

async function requiredReviewers (context, number) {
  const issue = await getPullRequest(context, number)

  return extractMentions(issue.data)
}

async function getPullRequest (context, number) {
  return await context.github.pullRequests.get(context.repo({ number }))
}

function extractMentions (pull_request) {
  const user = pull_request.user.login
  const match = pull_request.body.match(/^\s*\/review\s+(.+?)$/m)
  const comment = match && match[1]

  if (match && comment) {
    const mentions = comment.trim().split(/\s+/).map(mention => mention.replace('@', ''))

    if (mentions.includes(user)) {
      mentions.splice(mentions.indexOf(user), 1)
    }

    return new Set(mentions)
  } else { return new Set() }
}

async function getCheckRuns (context, check_suite_id) {
  const result = await context.github.checks.listForSuite(context.repo({ check_suite_id }))
  return result.data.check_runs
}

async function resetCheckRun (context, check_run_id) {
  return await context.github.checks.update(
    context.repo({
      check_run_id,
      conclusion: 'neutral',
      completed_at: new Date()
    })
  )
}

async function resetCheckSuite (context, check_suite_id) {
  const result = await context.github.checks.listForSuite(context.repo({ check_suite_id }))

  for (const { id } of result.data.check_runs) {
    await resetCheckRun(id)
  }

  return result.data.check_runs
}

async function askForReview (context, number, mentions, reviews) {
  const missing_reviews = new Set([...mentions].filter(name => !reviews.has(name)))

  const reviewers = [...missing_reviews].filter(mention => mention.indexOf('/') === -1)
  const team_reviewers = [...missing_reviews].filter(mention => mention.indexOf('/') !== -1)

  if (reviewers && team_reviewers) {
    await context.github.pullRequests.createReviewRequest(
      context.repo({ number, reviewers, team_reviewers })
    )
  }
}

async function updatePullRequest (pull_request, context) {

}

function isThisBot (sender) {
  return sender.type === 'Bot' && sender.login === 'probot-reviewers[bot]'
}

async function reset (context) {
  await resetCheckSuite(context.payload.check_suite.id, context)

  for (const { number } of context.payload.check_suite.pull_requests) {
    const pull_request = await getIssue(number, context)

    await updatePullRequest(pull_request.data, context)
  }
}

function reviewStatus (review) {
  switch (review.state) {
    case `changes_requested`:
      return { status: `completed`, conclusion: `success`, completed_at: review.submitted_at }
    case `dismissed`:
      return { status: `in_progress` }
    default:
      return { status: `completed`, conclusion: `success`, completed_at: review.submitted_at }
  }
}


async function createChecksRunsForMentions (context, pull_request, names) {
  const head_sha = pull_request.head.sha

  return await Promise.all(Array.from(names).map(async name => {
    return (await context.github.checks.create(context.repo({
      name: name,
      head_sha,
      status: 'queued',
      output: {
        title: `${name} pending review`,
        summary: `The check is is waiting or a review from @${name}!`
      }
    }))).data
  }))
}

async function checkSucceeded (context, check_run_id) {
  return await context.github.checks.update(
    context.repo({
      check_run_id,
      conclusion: 'success',
      completed_at: new Date()
    })
  )
}

async function listCheckRuns (context, pull_request) {
  const ref = pull_request.head.sha
  const app_id = process.env.APP_ID
  const result = await context.github.checks.listSuitesForRef(context.repo({ ref, app_id }))

  return (await Promise.all(result.data.check_suites.map(async ({ id }) => await getCheckRuns(context, id)))).flat()
}

async function reconcileCheckSuite (context, pull_request, mentions, reviewers) {
  const check_runs = new Map((await listCheckRuns(context, pull_request)).map(check => [ check.name, check ]))

  const missing = Array.from(mentions).filter(name => !check_runs.has(name))
  const extra = Array.from(check_runs.keys()).filter(name => !mentions.has(name))

  for (const check_run of await createChecksRunsForMentions(context, pull_request, missing)) {
    check_runs.set(check_run.name, check_run)
  }

  for (const name of extra) {
    await resetCheckRun(context, check_runs.get(name).id)
  }

  for (const name of reviewers) {
    await checkSucceeded(context, check_runs.get(name).id)
  }

  return check_runs
}

async function getReviewers (context, pull_request) {
  const check_runs = await listCheckRuns(context, pull_request)
  const requested_reviewers = pull_request.requested_reviewers.map(user => user.login)
  const requested_teams = pull_request.requested_teams
  const review_requests = [ ...requested_reviewers, ...requested_teams ]

  return new Set(check_runs.map(check_run => check_run.name).filter(name => !review_requests.includes(name)))
}

module.exports = app => {
  app.on(`*`, async context => {
    context.log({ event: context.event, action: context.payload.action })
  })

  app.on(['pull_request.opened', 'pull_request.reopened', 'pull_request.edited'], async context => {
    const pull_request = context.payload.pull_request
    const number = pull_request.number
    const mentions = await requiredReviewers(context, number)
    const reviewers = await getReviewers(context, pull_request)
    await reconcileCheckSuite(context, pull_request, mentions, reviewers)
    await askForReview(context, number, mentions, reviewers)
    // await askForReview(context, number, mentions)
    // await reconcileCheckSuite(context, pull_request, mentions)
  })

  app.on(`pull_request.review_requested`, async context => {
    const head_sha = context.payload.pull_request.head.sha
    const user = context.payload.requested_reviewer.login

    if (isThisBot(context.payload.sender)) {
      return context.github.checks.create(context.repo({
        name: user,
        head_sha,
        output: {
          title: `${user} asked for review`,
          summary: 'Waiting for the review.'
        }
      }))
    }

    context.log({ context })
  })

  app.on([`pull_request_review.submitted`, `pull_request_review.dismissed`], async context => {
    const review = context.payload.review
    const user = review.user.login
    const head_sha = review.commit_id
    const { status, conclusion, completed_at } = reviewStatus(review)

    return context.github.checks.create(context.repo({
      name: user,
      head_sha,
      status,
      conclusion,
      completed_at,
      output: {
        title: `${user} reviewed!`,
        summary: `The check is a ${conclusion}!`
      }
    }))
  })

  app.on(['check_suite.requested', 'check_suite.rerequested'], reset)

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
}
