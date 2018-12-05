// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more
module.exports = app => {
  app.on(`*`, async context => {
    context.log({ event: context.event, action: context.payload.action })
  })

  function extractReviewers (pull_request) {
    const user = pull_request.user.login
    const [match, comment] = pull_request.body.match(/^\s*\/review\s+(.+?)$/)

    if (match) {
      const mentions = comment.trim().split(/\s+/).map(mention => mention.replace('@', ''))

      const reviewers = mentions.filter(mention => mention.indexOf('/') === -1)
      const team_reviewers = mentions.filter(mention => mention.indexOf('/') !== -1)

      if (reviewers.includes(user)) {
        reviewers.splice(reviewers.indexOf(user), 1)
      }

      return [reviewers, team_reviewers]
    }
  }

  function createUserChecks(users) {

  }

  function createTeamChecks(users) {

  }

  app.on(`pull_request.edited`, async context => {
    const [ reviewers, team_reviewers ] = extractReviewers(context.payload.pull_request)

    if (reviewers && team_reviewers) {
      const result = await context.github.pullRequests.createReviewRequest(
        context.issue({ reviewers, team_reviewers })
      )

      context.log({ result, event: context.event, action: context.payload.action })


      createUserChecks(reviewers)
      createTeamChecks(team_reviewers)

    }
  })

  app.on(`pull_request.review_requested`, async context => {
    const head_sha = context.payload.pull_request.head.sha
    const user = context.payload.requested_reviewer.login

    return context.github.checks.create(context.repo({
      name: user,
      head_sha,
      output: {
        title: `${user} asked for review`,
        summary: 'Waiting for the review.'
      }
    }))
    context.log({ context })
  })

  function reviewStatus(review) {
    switch (review.state) {
      case `changes_requested`:
        return { status: `completed`, conclusion: `failure`, completed_at: review.submitted_at }
      case `dismissed`:
        return { status: `in_progress` }
      default:
        return { status: `completed`, conclusion: `success`, completed_at: review.submitted_at }
    }
  }

  app.on([`pull_request_review.submitted`, `pull_request_review.dismissed`], async context => {
    const review = context.payload.review
    const user = review.user.login
    const head_sha = review.commit_id
    const { status, conclusion, completed_at } = reviewStatus(review)

    return context.github.checks.create(context.repo({
      name: user,
      head_sha,
      status, conclusion, completed_at,
      output: {
        title: `${user} reviewed!`,
        summary: `The check is a ${conclusion}!`
      }
    }))
  })

  app.on(['check_suite.requested', 'check_suite.rerequested'], check)

  async function check (context) {
    // Do stuff
    const { head_branch, head_sha } = context.payload.check_suite
    // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
    return context.github.checks.create(context.repo({
      name: 'My app!',
      head_branch,
      head_sha,
      output: {
        title: 'Probot check!',
        summary: 'The check has passed!'
      }
    }))
  }

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
}
