// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next'
import generator from 'megalodon'
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@prisma/client/runtime/library';
import { prisma } from '../../../lib/prisma'
import fs from 'fs';

const dotenv = require('dotenv')
dotenv.config()

export default async (req: NextApiRequest, res: NextApiResponse) => {
    // Only allow POST Requests
    if (req.method !== 'POST') {
        return res
            .status(405)
            .json({ message: 'Invalid API Method', type: 'error' })
    }

    // Define the incoming POST Data
    const instanceData: { uri: string; type: string; nsfwflag: string; api_mode: string; instance_contact?: string } =
        req.body

    // Function to parse through the URI and check if it's valid and return the data
    async function testURI(instanceURI: string, instanceType: string) {
        if (instanceType == 'mastodon') {
            let init = { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }
            let verifyURI = 'https://' + instanceURI + '/api/v1/instance'
            try {
                const fetchingData = await fetch(verifyURI, init)
                const mastodonData = await fetchingData.json()
                const parsedMasterData = {
                    title: mastodonData.title,
                    description: mastodonData.short_description !== undefined ? mastodonData.short_description : mastodonData.description, // Pleroma instances don't have a short_description field, so we use the description field instead
                    thumbnail: mastodonData.thumbnail,
                    user_count: mastodonData.stats.user_count,
                    status_count: mastodonData.stats.status_count,
                    instance_contact: mastodonData.contact_account.username,
                    registrations: mastodonData.registrations,
                    approval_required: mastodonData.approval_required,
                }
                return parsedMasterData
            } catch (err) {
                return false
            }
        } else if (instanceType == 'misskey') {
            let getDetails = { detail: true }
            let init = { 
                headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                body: JSON.stringify(getDetails),
                method: 'POST'
            }
            let metaURI = 'https://' + instanceURI + '/api/meta'
            let statsURI = 'https://' + instanceURI + '/api/stats'
            try {
                const fetchingData = await fetch(metaURI, init)
                const fetchingData2 = await fetch(statsURI, init)
                const misskeyMetaData = await fetchingData.json()
                const misskeyStatsData = await fetchingData2.json()
                const parsedMasterData = {
                    title: misskeyMetaData.name,
                    description: misskeyMetaData.description,
                    thumbnail: misskeyMetaData.bannerUrl,
                    user_count: misskeyStatsData.originalUsersCount,
                    status_count: misskeyStatsData.notesCount,
                    instance_contact: 'null',
                    registrations: misskeyMetaData.disableRegistration === false,
                    approval_required: false,
                }
                return parsedMasterData
            } catch (err) {
                return false
            }
        } else {

            return false
        }
    }

    // function to save the image to disk for use later
    // this gets called below when we get to storing the image to disk
    async function imgToDisk(url: string, filePath: string): Promise<void> {
        try {
            //get the image
            const response = await fetch(url);

            //if no image throw error
            if (!response.ok) {
                throw new Error('Image failed to be fetched: ${response.status} ${response.statusText}');
            }
            
            //convert to blob
            const blob = await response.blob();

            //make new locaL URL
            const localURL = URL.createObjectURL(blob);

            //create anchor and trigger download
            const anchor = document.createElement('a');
            anchor.href = localURL;
            //we give the full path with name of the file
            anchor.download = filePath || 'downloaded-image';
            document.body.appendChild(anchor);
            anchor.click();

            //clean up all our stuff now
            setTimeout(() => {
                URL.revokeObjectURL(localURL);
                document.body.removeChild(anchor);
            }, 0);
        }
        catch (error) {

        }
    }
    

    // Run through the URI test and collect the data
    // Then create the instance in the database
    if ((await testURI(instanceData.uri, instanceData.api_mode)) == false) {
        // Return an error if the URI is invalid
        res.status(400).json({ message: 'failed to verify URI', type: 'error' })
    } else {
        let cachedata = await testURI(instanceData.uri, instanceData.api_mode)
        let imageLoc:string;
        let hasImg:boolean = false;
        if (cachedata != false) {
            try {
                //TODO: capture the thumbnail and store to disk to avoid having site to grab it and store it in webp (probably translate via next.js)
                //make sure there is a thumbnail
                if (cachedata.thumbnail != null){
                    //grab the url to the image
                    imageLoc = cachedata.thumbnail;
                    hasImg = true;
                }

                //setup for saving the name of the file in the database and on disk
                const filePath: string = './img/' + cachedata.title;

                //if there is an image then we want to save it
                if(hasImg){
                    imgToDisk(imageLoc, filePath);
                }
                // Prepare the data to be saved to the database
                const savedInstance = await prisma.instances.create({
                    data: {
                        name: cachedata.title,
                        api_mode: instanceData.api_mode,
                        type: instanceData.type,
                        nsfwflag: instanceData.nsfwflag,
                        uri: instanceData.uri,
                        verified: false,
                        InstanceData: {
                            create: {
                                title: cachedata.title,
                                description: cachedata.description,
                                thumbnail: filePath,
                                user_count: cachedata.user_count,
                                status_count: cachedata.status_count,
                                registrations: cachedata.registrations,
                                approval_required: cachedata.approval_required,
                            },
                        },
                        ApiKeys: {
                            create: {}
                        }
                    },

                })

                console.log(savedInstance)

                // Absolutely force the value to be false after creation!
                const unverifiedInstance = await prisma.instances.update({
                    where: { uri: instanceData.uri },
                    data: { verified: false },
                })

                const getAPIKey = await prisma.apiKeys.findFirst({
                    where: { instance_id: savedInstance.id }
                })

                // Build the mastodon client
                const client = generator(
                    'mastodon',
                    process.env.MASTODON_URL,
                    process.env.ACCESS_TOKEN
                )              

                // Check if the user is allowed to submit the isntance
                if (instanceData.api_mode == 'mastodon') {
                    // Set the instacne contact
                    let instanceContact = cachedata.instance_contact
                    // Compose Toot
                    let toot =
                        '@' +
                        instanceContact +
                        '@' +
                        instanceData.uri +
                        ' Hi there someone is attempting to register your instance on FurryFediverse, if this is you. Please click this link to finish the registration: https://furryfediverse.org/api/instances/verify/' +
                        getAPIKey.api_key
                    res.status(200).json({
                        message:
                            'Added instance successfully, your instance admin account needs to be verified! Check your DMs!',
                        type: 'success',

                    })
                    client
                        .postStatus(toot, { visibility: 'direct' })
                } else if (instanceData.api_mode == 'misskey') {
                    // Set the instance contact
                    let instanceContact = instanceData.instance_contact
                    // Check submitted user is admin
                    let adminVerify = {
                        query: instanceContact,
                        limit: 1,
                        origin: "local",
                        detail: true
                    }
                    let init = { 
                        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                        body: JSON.stringify(adminVerify),
                        method: 'POST'
                    }
                    let adminReq = await fetch('https://' + instanceData.uri + '/api/users/search', init)
                    let adminRes = await adminReq.json()
                    if (adminRes[0].isAdmin == true){
                        console.log('Admin verification passed')
                        // Compose Toot
                        let toot =
                            '@' +
                            instanceContact +
                            '@' +
                            instanceData.uri +
                            ' Hi there someone is attempting to register your instance on FurryFediverse, if this is you. Please click this link to finish the registration: https://furryfediverse.org/api/instances/verify/' +
                            getAPIKey.api_key
                        res.status(200).json({
                            message:
                                'Added instance successfully, your instance admin account needs to be verified! Check your DMs!',
                            type: 'success',
                        })
                        client
                            .postStatus(toot, { visibility: 'direct' })
                    }else{
                        res.status(400).json({
                            message: 'Administrator verification failed',
                            type: 'error',
                        })
                    }
                }

            } catch (err) {
                console.log(err)
                if (err instanceof PrismaClientKnownRequestError) {
                    if (err.code === 'P2002') {
                        res.status(400).json({
                            message: 'Instance already exists',
                            type: 'error',
                        })
                    } else {
                        res.status(400).json({
                            message: err.message,
                            type: 'error',
                        })
                    }
                } else if (err instanceof PrismaClientValidationError) {
                    res.status(400).json({ message: err.message, type: 'error' })
                }
            }
        }
    }
}
